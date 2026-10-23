#pragma once
// Node Protocol v2 — HTTP polling client for the Espresso control plane.
// Replaces the WebSocket v3 transport (server lives on Vercel now, which
// cannot host WebSockets). Wire contract is implemented server-side in
// packages/node-server/src/nodes/ingest.ts:
//
//   POST /node/pair     {id, code, name, pubkey, ts, sig}           -> {ok}
//   POST /node/poll     {id, token?, pubkey?, ts, sig?, + telemetry}
//                       -> {ok, online, commands:[{req_id?, action, ...}]}
//   POST /node/respond  {id, token, req_id, ok, error?, ...payload} -> {ok}
//
// - Signed payloads are "<action>:<id>:<tsMillis>" over Ed25519 (hex).
// - Once paired, the stored token is the sole bearer credential; the
//   signature is only needed for pairing messages (pair, unpaired poll).
// - Commands arrive in the poll's `commands` array and are answered with
//   POST /node/respond keyed by req_id. pair_ok and reqless repo_list
//   pushes have no req_id (pair_ok completes pairing; repo_list is given
//   a synthetic req_id so the server can refresh its repo index anyway).

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <base64.h>
#include <mbedtls/base64.h>
#include <vector>
#include "config.h"
#include "ch375b.h"
#include "storage.h"
#include "provision.h"

// Ed25519 via Monocypher (lightweight, no mbedtls dependency)
extern "C" {
#include <monocypher.h>
}

class NodeProtocol {
public:
    bool     paired = false;
    bool     online = false;
    String   token;
    uint64_t uptimeStart = 0;

    void begin() {
        uptimeStart = millis();
        if (provision.configured && !provision.authToken.isEmpty()) {
            token = provision.authToken;
            paired = true;
        }
    }

    // No persistent connection to open in v2: HTTP requests are made
    // per-poll. Kept for lifecycle parity with the WebSocket version.
    void connect() {
        if (!provision.configured) return;
        log_i("HTTP polling %s:%d (base path %s), TLS=%s",
              provision.serverHost.c_str(), provision.serverPort,
              provision.serverPath.c_str(),
              provision.serverPort == 443 ? "yes (port 443)" : "no (plain HTTP)");
    }

    void loop() {
        if (!provision.configured) return;

        static uint32_t lastTick = 0;
        static uint32_t lastPair = 0;
        uint32_t now = millis();
        if (now - lastTick < (uint32_t)POLL_INTERVAL_MS) return;
        lastTick = now;

        if (paired && !token.isEmpty()) {
            pollPaired();
            return;
        }

        // Unpaired: refresh the pairing registration on PAIR_RETRY_MS so the
        // server-side paircode TTL stays fresh, then poll for pair_ok.
        if (now - lastPair >= (uint32_t)PAIR_RETRY_MS) {
            lastPair = now;
            ensurePairCode();
            sendPairRequest(provision.pairCode.c_str());
        }
        pollUnpaired();
    }

    // Guarantees a (stable) pairing code exists before requesting pairing.
    void ensurePairCode() {
        if (provision.pairCode.isEmpty()) {
            provision.pairCode = Provision::genPairCode();
            provision.savePairCode(provision.pairCode);
        }
    }

    // ── Outgoing messages ─────────────────────────────

    void sendPairRequest(const char* code) {
        if (!provision.configured) return;
        JsonDocument doc;
        doc["id"]     = provision.nodeId;
        doc["code"]   = code;
        doc["name"]   = provision.nodeName;
        doc["pubkey"] = provision.pubkeyHex;
        doc["ts"]     = (double)millis();
        signDoc(doc, "pair");

        JsonDocument resp;
        int status = 0;
        if (!postDoc("/node/pair", doc, resp, status)) {
            log_w("pair_request POST failed");
            return;
        }
        if (status != 200) {
            log_w("pair_request rejected (HTTP %d)", status);
        } else {
            log_i("pair_request sent and accepted waiting for /api/nodes/pair (code=%s)", code);
        }
    }

    void pollPaired() {
        JsonDocument poll;
        poll["id"]            = provision.nodeId;
        poll["token"]         = token;
        poll["name"]          = provision.nodeName;
        poll["fw"]            = FIRMWARE_VERSION;
        poll["pubkey"]        = provision.pubkeyHex;
        poll["ts"]            = (double)millis();
        poll["uptime_s"]      = (millis() - uptimeStart) / 1000;
        poll["storage_free"]  = storage.freeBytes();
        poll["storage_total"] = storage.totalBytes();
        poll["ram_total"]     = ESP.getHeapSize();
        poll["heap_free"]     = ESP.getFreeHeap();
        poll["wifi_rssi"]     = WiFi.RSSI();

        JsonDocument resp;
        int status = 0;
        if (!postDoc("/node/poll", poll, resp, status)) {
            online = false;
            return;
        }
        if (status == 401) {
            // Bad/persisted token (server said pair_rejected): start over.
            log_w("hello rejected — clearing stored token");
            online = false;
            paired = false;
            token  = "";
            return;
        }
        if (status != 200) {
            online = false;
            return;
        }
        online = true;
        drainCommands(resp);
    }

    void pollUnpaired() {
        JsonDocument poll;
        poll["id"]     = provision.nodeId;
        poll["pubkey"] = provision.pubkeyHex;
        poll["ts"]     = (double)millis();
        signDoc(poll, "poll");

        JsonDocument resp;
        int status = 0;
        if (!postDoc("/node/poll", poll, resp, status)) {
            return;
        }
        if (status == 200) drainCommands(resp);
    }

    // ── Incoming command dispatch ─────────────────────

    void drainCommands(JsonDocument& resp) {
        if (!resp["commands"].is<JsonArray>()) return;
        // All commands in this batch were already consumed server-side, so
        // every one of them must be handled now or they are lost.
        for (JsonObject cmdObj : resp["commands"].as<JsonArray>()) {
            JsonDocument cmd;
            cmd.set(cmdObj);
            handleCommand(cmd);
        }
    }

    void handleCommand(JsonDocument& cmd) {
        String action = cmd["action"] | "";
        String reqId  = cmd["req_id"] | "";

        if (action == "pair_ok") {
            token  = (const char*)(cmd["token"] | "");
            paired = true;
            provision.saveToken(token);
            log_i("PAIRED! node_id=%s (token saved, %d bytes)",
                  (const char*)(cmd["node_id"] | ""), token.length());
            return;
        }

        log_i("cmd: %s (req_id=%s)", action.c_str(), reqId.c_str());

        if (action == "ping") {
            respondAck(reqId);
        } else if (action == "repo_list") {
            sendRepoList(reqId);
        } else if (action == "repo_create") {
            handleRepoCreate(cmd, reqId);
        } else if (action == "repo_delete") {
            handleRepoDelete(cmd, reqId);
        } else if (action == "fs_read") {
            handleFSRead(cmd, reqId);
        } else if (action == "fs_write") {
            handleFSWrite(cmd, reqId);
         } else if (action == "fs_list") {
            handleFSList(cmd, reqId);
         } else if (action == "fs_mkdir") {
            handleFSMkdir(cmd, reqId);
         } else if (action == "refs_list") {
            handleRefsList(cmd, reqId);
        } else if (action == "storage_reinit") {
            bool ok = storage.reinit();
            if (ok) {
                respondAck(reqId);
            } else {
                respondError(reqId, "storage_reinit_failed");
            }
        } else if (action == "storage_status") {
            handleStorageStatus(reqId);
        } else {
            respondError(reqId, "unsupported_action");
        }
    }

    void handleRepoCreate(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        if (repo.isEmpty() || repo.length() > 64) {
            respondError(reqId, "invalid_repo_name");
            return;
        }
        if (!storage.hasStorage()) {
            respondError(reqId, "no_storage_available");
            return;
        }
        String dir = String(SD_MOUNT_POINT) + "/" + repo;
        log_i("repo_create: creating %s at %s", repo.c_str(), dir.c_str());
        bool ok = storage.mkdir(dir.c_str());
        if (ok) {
            respondAck(reqId);
            sendRepoList(String("fwr") + millis());  // refresh index
        } else {
            respondError(reqId, storage.sdOk ? "mkdir_failed_sd"
                          : (storage.usbOk ? "mkdir_failed_usb" : "mkdir_failed_no_storage"));
        }
    }

    void handleRepoDelete(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        if (repo.isEmpty() || repo.length() > 64) {
            respondError(reqId, "invalid_repo_name");
            return;
        }
        if (!storage.hasStorage()) {
            respondError(reqId, "no_storage_available");
            return;
        }
        String dir = String(SD_MOUNT_POINT) + "/" + repo;
        bool ok = storage.removeFile(dir.c_str());
        if (ok) {
            respondAck(reqId);
            sendRepoList(String("fwr") + millis());  // refresh index
        } else {
            respondError(reqId, "remove_failed");
        }
    }

    void handleFSRead(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        String path = (const char*)(cmd["path"] | "");
        uint32_t offset = (uint32_t)(cmd["offset"] | 0u);
        int len = cmd["len"] | 8192;
        if (len <= 0 || len > 8192) len = 8192;  // single-chunk reads

        String fullPath = String(SD_MOUNT_POINT) + "/" + repo + "/" + path;

        uint8_t buf[8192];
        size_t n = storage.readFile(fullPath.c_str(), offset, buf, sizeof(buf));

        JsonDocument resp;
        resp["id"]       = provision.nodeId;
        resp["token"]    = token;
        resp["req_id"]   = reqId;
        resp["ok"]       = true;
        resp["offset"]   = offset;
        resp["len"]      = (int)n;
        resp["eof"]      = (n < (size_t)len);
        resp["data_b64"] = base64::encode(buf, n);
        postRespond(resp);
    }

    void handleFSWrite(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        String path = (const char*)(cmd["path"] | "");
        uint32_t offset = (uint32_t)(cmd["offset"] | 0u);
        String b64 = (const char*)(cmd["data"] | "");

        String fullPath = String(SD_MOUNT_POINT) + "/" + repo + "/" + path;

        size_t decodedLen = 0;
        mbedtls_base64_decode(nullptr, 0, &decodedLen,
                              (const uint8_t*)b64.c_str(), b64.length());
        uint8_t* decoded = (uint8_t*)malloc(decodedLen);
        if (decoded == nullptr) {
            respondError(reqId, "alloc_failed");
            return;
        }
        size_t actualLen = 0;
        int rc = mbedtls_base64_decode(decoded, decodedLen, &actualLen,
                                       (const uint8_t*)b64.c_str(), b64.length());

        bool ok = (rc == 0 && actualLen > 0 &&
                   storage.writeFile(fullPath.c_str(), offset, decoded, actualLen));
        free(decoded);

        if (ok) respondAck(reqId);
        else    respondError(reqId, "write_failed");
    }

    void handleFSList(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        String path = (const char*)(cmd["path"] | "");
        String fullPath = String(SD_MOUNT_POINT) + "/" + repo + "/" + path;

        JsonDocument resp;
        resp["id"]     = provision.nodeId;
        resp["token"]  = token;
        resp["req_id"] = reqId;
        resp["ok"]     = true;

        JsonArray entries = resp["entries"].to<JsonArray>();
        storage.listDir(fullPath.c_str(),
            [&entries](const char* name, bool isDir, uint32_t size) {
                JsonObject e = entries.add<JsonObject>();
                e["name"] = name;
                e["dir"]  = isDir;
                e["size"] = size;
            });
        postRespond(resp);
    }

    void handleFSMkdir(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        String path = (const char*)(cmd["path"] | "");
        String fullPath = String(SD_MOUNT_POINT) + "/" + repo + "/" + path;
        bool ok = storage.mkdir(fullPath.c_str());
        if (ok) respondAck(reqId);
        else respondError(reqId, "mkdir_failed");
    }

    // Minimal git refs listing for bare repos: branches under refs/heads,
    // tags under refs/tags. Empty when the repo is not a bare git dir.
    void handleRefsList(JsonDocument& cmd, const String& reqId) {
        String repo = (const char*)(cmd["repo"] | "");
        std::vector<String> branches, tags;
        collectNames(String(SD_MOUNT_POINT) + "/" + repo + "/refs/heads", branches);
        collectNames(String(SD_MOUNT_POINT) + "/" + repo + "/refs/tags", tags);

        std::vector<String> commits;
        std::vector<String> seen;
        for (const String& name : branches) {
            String refPath = String(SD_MOUNT_POINT) + "/" + repo + "/refs/heads/" + name;
            uint8_t buf[64];
            size_t n = storage.readFile(refPath.c_str(), 0, buf, sizeof(buf));
            if (n == 0) continue;
            String sha = "";
            for (size_t i = 0; i < n && i < 40; i++) {
                char c = (char)buf[i];
                if (c == '\\n' || c == '\\r' || c == ' ') break;
                sha += c;
            }
            if (sha.length() < 7) continue;
            bool dup = false;
            for (const String& s : seen) if (s == sha) { dup = true; break; }
            if (dup) continue;
            seen.push_back(sha);
            commits.push_back(sha);
        }

        JsonDocument resp;
        resp["id"]     = provision.nodeId;
        resp["token"]  = token;
        resp["req_id"] = reqId;
        resp["ok"]     = true;
        JsonArray b = resp["branches"].to<JsonArray>();
        for (const String& name : branches) b.add(name);
        JsonArray t = resp["tags"].to<JsonArray>();
        for (const String& name : tags) t.add(name);
        JsonArray c = resp["commits"].to<JsonArray>();
        for (const String& name : commits) c.add(name);
        postRespond(resp);
    }

    void handleStorageStatus(const String& reqId) {
        JsonDocument resp;
        resp["id"]              = provision.nodeId;
        resp["token"]           = token;
        resp["req_id"]          = reqId;
        resp["ok"]              = true;
        resp["sd_ok"]           = storage.sdOk;
        resp["usb_ok"]          = storage.usbOk;
        resp["flash_ok"]        = storage.flashOk;
        resp["ch375b_available"] = ch375b.available;
        resp["status"]          = storage.getStatusString();
        resp["detailed"]        = storage.getDetailedStatus();
        resp["total_bytes"]     = storage.totalBytes();
        resp["free_bytes"]      = storage.freeBytes();
        resp["sd_total"]        = storage.sdOk ? SD.totalBytes() : 0;
        resp["sd_free"]         = storage.sdOk ? (SD.totalBytes() - SD.usedBytes()) : 0;
        resp["usb_total"]       = storage.usbOk ? (uint64_t)ch375b.diskCapacity() * 512 : 0;
        resp["flash_total"]     = storage.flashTotalBytes();
        resp["flash_free"]      = storage.flashFreeBytes();
        postRespond(resp);
    }

    void sendRepoList(const String& reqId) {
        JsonDocument resp;
        resp["id"]     = provision.nodeId;
        resp["token"]  = token;
        resp["req_id"] = reqId;
        resp["ok"]     = true;
        resp["action"] = "repo_list";
        JsonArray repos = resp["repositories"].to<JsonArray>();
        storage.listDir("/",
            [&repos](const char* name, bool isDir, uint32_t size) {
                if (isDir) {
                    JsonObject r = repos.add<JsonObject>();
                    r["name"] = name;
                    r["size"] = size;
                }
            });
        postRespond(resp);
        log_i("repo_list responded (%d repos)", int(repos.size()));
    }

    // ── Respond mechanics ─────────────────────────────

    void respondAck(const String& reqId) {
        JsonDocument resp;
        resp["id"]     = provision.nodeId;
        resp["token"]  = token;
        resp["req_id"] = reqId;
        resp["ok"]     = true;
        postRespond(resp);
    }

    void respondError(const String& reqId, const char* errMsg) {
        JsonDocument resp;
        resp["id"]     = provision.nodeId;
        resp["token"]  = token;
        resp["req_id"] = reqId;
        resp["ok"]     = false;
        resp["error"]  = errMsg;
        postRespond(resp);
    }

    // Sends a fully-built response document. Skips when there is no req_id
    // (unsolicited answers need one) and when unpaired.
    void postRespond(JsonDocument& resp) {
        String reqId = (const char*)(resp["req_id"] | "");
        if (token.isEmpty() || reqId.isEmpty()) return;
        int status = 0;
        JsonDocument ack;
        if (!postDoc("/node/respond", resp, ack, status)) {
            log_w("respond POST failed (req_id=%s)", reqId.c_str());
        }
    }

private:
    // ── Minimal HTTP/1.1 JSON POST client ─────────────
    //
    // TLS when serverPort == 443 (Vercel production), plain HTTP otherwise
    // (LAN dev server). No certificate validation (setInsecure): trust is
    // anchored at the application layer by the node's stored token and
    // Ed25519-signed messages, mirroring the old plaintext WebSocket.

    bool postDoc(const String& path, JsonDocument& doc, JsonDocument& out, int& status) {
        String body = doc.as<String>();
        String raw;
        if (!httpFetch(path, body, raw, status)) return false;

        int hdrEnd = raw.indexOf("\r\n\r\n");
        String headers = raw.substring(0, hdrEnd < 0 ? raw.length() : hdrEnd);
        String payload = (hdrEnd >= 0) ? raw.substring(hdrEnd + 4) : String("");

        String lower = headers;
        lower.toLowerCase();
        if (lower.indexOf("chunked") >= 0) payload = decodeChunked(payload);

        DeserializationError err = deserializeJson(out, payload);
        if (err) {
            log_w("bad JSON from server (HTTP %d): %s", status, err.c_str());
            return false;
        }
        return true;
    }

    bool httpFetch(const String& path, const String& body, String& raw, int& status) {
        if (WiFi.status() != WL_CONNECTED) {
            online = false;
            return false;
        }
        status = 0;
        raw = "";
        uint16_t port = provision.serverPort;

        // TLS when provisioned port is 443 (Vercel production), plain HTTP
        // otherwise (LAN dev). WiFiClientSecure derives from WiFiClient, so
        // both share one interface here.
        WiFiClientSecure secure;
        WiFiClient plain;
        bool tl = (port == 443);
        if (tl) {
            secure.setInsecure();
            secure.setTimeout(HTTP_TIMEOUT_MS);
            secure.setHandshakeTimeout(HTTP_TIMEOUT_MS / 1000);
        } else {
            plain.setTimeout(HTTP_TIMEOUT_MS);
        }
        WiFiClient& client = tl ? (WiFiClient&)secure : plain;

        if (client.connect(provision.serverHost.c_str(), port) != 1) {
            log_w("HTTP connect failed: %s:%d", provision.serverHost.c_str(), port);
            online = false;
            return false;
        }

        String req = "POST " + path + " HTTP/1.1\r\n";
        req += "Host: " + provision.serverHost + "\r\n";
        req += "Content-Type: application/json\r\n";
        req += "Accept-Encoding: identity\r\n";  // gzip would break the JSON parse
        req += "Content-Length: " + String(body.length()) + "\r\n";
        req += "Connection: close\r\n\r\n";
        client.print(req);
        client.write((const uint8_t*)body.c_str(), body.length());

        uint32_t deadline = millis() + (uint32_t)HTTP_TIMEOUT_MS;
        while (millis() < deadline) {
            while (client.available()) raw += (char)client.read();
            if (!client.connected()) break;
            delay(1);
        }
        client.stop();

        if (raw.isEmpty()) {
            log_w("empty HTTP response for %s", path.c_str());
            online = false;
            return false;
        }

        // "HTTP/1.1 200 OK"
        int sp1 = raw.indexOf(' ');
        int sp2 = raw.indexOf(' ', sp1 + 1);
        if (sp1 >= 0 && sp2 > sp1) status = raw.substring(sp1 + 1, sp2).toInt();
        return true;
    }

    static String decodeChunked(const String& chunked) {
        String out;
        out.reserve(chunked.length());
        size_t i = 0;
        while (i < chunked.length()) {
            // chunk size line: "<hex>[;ext]\r\n"
            int nl = chunked.indexOf("\r\n", i);
            if (nl < 0) break;
            int semi = chunked.indexOf(';', i);
            String sizeHex = chunked.substring(i, semi >= 0 && semi < nl ? semi : nl);
            sizeHex.trim();
            long size = strtol(sizeHex.c_str(), nullptr, 16);
            i = nl + 2;
            if (size == 0) break;
            out += chunked.substring(i, min(i + (size_t)size, chunked.length()));
            i += (size_t)size + 2;  // skip chunk + trailing CRLF
        }
        return out;
    }

    // ── Signing / hex helpers (unchanged from v3) ─────

    void signDoc(JsonDocument& doc, const char* action) {
        String nid = provision.nodeId;
        double ts  = doc["ts"] | 0.0;
        String payload = String(action) + ":" + nid + ":" + String((uint64_t)ts);

        uint8_t seed[32];
        hexDecode(provision.privkeyHex.c_str(), seed, 32);

        uint8_t sig[64];
        crypto_sign(sig, seed, nullptr,
                    (const uint8_t*)payload.c_str(), payload.length());

        doc["sig"] = hexEncode(sig, 64);
    }

    void collectNames(const String& dir, std::vector<String>& names) {
        storage.listDir(dir.c_str(),
            [&names](const char* name, bool isDir, uint32_t size) {
                (void)isDir; (void)size;
                names.push_back(String(name));
            });
    }

    static void hexDecode(const char* hex, uint8_t* out, size_t len) {
        for (size_t i = 0; i < len; i++) {
            uint8_t hi = hexCharToNibble(hex[i * 2]);
            uint8_t lo = hexCharToNibble(hex[i * 2 + 1]);
            out[i] = (uint8_t)((hi << 4) | lo);
        }
    }

    static String hexEncode(const uint8_t* data, size_t len) {
        String s;
        s.reserve(len * 2);
        const char* tbl = "0123456789ABCDEF";
        for (size_t i = 0; i < len; i++) {
            s += tbl[data[i] >> 4];
            s += tbl[data[i] & 0x0F];
        }
        return s;
    }

    static uint8_t hexCharToNibble(char c) {
        if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
        if (c >= 'A' && c <= 'F') return (uint8_t)(c - 'A' + 10);
        if (c >= 'a' && c <= 'f') return (uint8_t)(c - 'a' + 10);
        return 0;
    }
};

extern NodeProtocol node;
extern Provision provision;
