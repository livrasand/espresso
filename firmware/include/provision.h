#pragma once
// Espresso Node Provisioning — WiFi AP + captive portal + first-run setup.
// Stores node_id, wifi_ssid, wifi_pass, server_host, server_port,
// server_path (Node Protocol v2 base), node_name, pubkey_hex, privkey_hex
// in NVS Preferences.

#include <Arduino.h>
#include <WiFi.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include "config.h"
#include "protocol.h"
extern "C" {
#include <monocypher.h>
}

class Provision {
public:
    bool configured = false;
    String nodeId;
    String nodeName;
    String wifiSSID;
    String wifiPass;
    String serverHost;
    uint16_t serverPort;
    String serverPath;   // Node Protocol v2 base, e.g. "/node"
    String pubkeyHex;
    String privkeyHex;
    String pairCode;
    String authToken;
    bool pairing = false;

    void begin() {
        Preferences prefs;
        prefs.begin("Espresso", true);
        configured = prefs.getBool("configured", false);
        if (!configured) {
            prefs.end();
            return;
        }
        nodeId     = prefs.getString("node_id", "");
        nodeName   = prefs.getString("node_name", "");
        wifiSSID   = prefs.getString("wifi_ssid", "");
        wifiPass   = prefs.getString("wifi_pass", "");
        serverHost = prefs.getString("server_host", "");
        serverPort = prefs.getUShort("server_port", 443);
        // Migrate legacy v3 provisioning: it stored the full WebSocket path
        // ("/node/ws"); strip it down to the v2 base.
        serverPath = prefs.getString("server_path", "");
        if (serverPath.isEmpty()) {
            String legacy = prefs.getString("server_ws_path", "");
            if (legacy.isEmpty()) serverPath = "/node";
            else if (legacy.indexOf("/node/ws") == 0) serverPath = "/node";
            else serverPath = legacy;
        }
        sanitize();
        pubkeyHex  = prefs.getString("pubkey_hex", "");
        privkeyHex = prefs.getString("privkey_hex", "");
        pairCode   = prefs.getString("pair_code", "");
        authToken  = prefs.getString("auth_token", "");
        prefs.end();
    }

    // Normalize user-provided server endpoints: accept full URLs like
    // "http://host:port/path" and reduce them to host/port/path.
    void sanitize() {
        String h = serverHost;
        h.trim();
        if (h.startsWith("http://")) h = h.substring(7);
        else if (h.startsWith("https://")) h = h.substring(8);
        int slash = h.indexOf('/');
        if (slash >= 0) { serverPath = h.substring(slash); h = h.substring(0, slash); }
        int colon = h.indexOf(':');
        if (colon >= 0) {
            String ps = h.substring(colon + 1);
            if (ps.length() > 0 && ps.toInt() > 0) serverPort = (uint16_t)ps.toInt();
            h = h.substring(0, colon);
        }
        if (h.length() > 0) serverHost = h;
        if (serverPath.isEmpty() || serverPath.indexOf("http") == 0) serverPath = "/node";
        if (serverPath.length() > 0 && !serverPath.startsWith("/")) serverPath = "/" + serverPath;
    }

    bool save(const String& name, const String& ssid, const String& pass,
              const String& host, uint16_t port, const String& path,
              const String& nid, const String& pub, const String& priv) {
        Preferences prefs;
        prefs.begin("Espresso", false);
        prefs.putBool("configured", true);
        prefs.putString("node_id", nid);
        prefs.putString("node_name", name);
        // Normalize before persisting so a user-entered URL is handled.
        serverHost = host;
        serverPort = port;
        serverPath = path;
        sanitize();
        prefs.putString("wifi_ssid", ssid);
        prefs.putString("wifi_pass", pass);
        prefs.putString("server_host", serverHost);
        prefs.putUShort("server_port", serverPort);
        prefs.putString("server_path", serverPath);
        prefs.putString("pubkey_hex", pub);
        prefs.putString("privkey_hex", priv);
        prefs.putString("pair_code", pairCode);
        prefs.putString("auth_token", authToken);
        prefs.end();
        nodeId = nid;
        nodeName = name;
        wifiSSID = ssid;
        wifiPass = pass;
        pubkeyHex = pub;
        privkeyHex = priv;
        configured = true;
        return true;
    }

    bool saveToken(const String& token) {
        Preferences prefs;
        prefs.begin("Espresso", false);
        prefs.putString("auth_token", token);
        prefs.end();
        authToken = token;
        return true;
    }

    bool savePairCode(const String& code) {
        Preferences prefs;
        prefs.begin("Espresso", false);
        prefs.putString("pair_code", code);
        prefs.end();
        pairCode = code;
        return true;
    }

    bool reset() {
        Preferences prefs;

        if (!prefs.begin("Espresso", false)) {
            return false;
        }

        prefs.clear();
        prefs.end();

        // Limpiar también el estado en RAM
        configured = false;
        nodeId = "";
        nodeName = "";
        wifiSSID = "";
        wifiPass = "";
        serverHost = "";
        serverPort = 443;
        serverPath = "/node";
        pubkeyHex = "";
        privkeyHex = "";
        pairCode = "";
        authToken = "";
        pairing = false;

        return true;
    }

    static String genNodeId() {
        uint8_t b[4];
        for (int i = 0; i < 4; i++) b[i] = random(0, 256);
        char out[9];
        for (int i = 0; i < 4; i++) sprintf(out + i * 2, "%02X", b[i]);
        return String(out);
    }

    static String genKeyHex() {
        uint8_t seed[32];
        for (int i = 0; i < 32; i++) seed[i] = random(0, 256);
        uint8_t pub[32];
        crypto_sign_public_key(pub, seed);
        char out[65];
        for (int i = 0; i < 32; i++) sprintf(out + i * 2, "%02X", pub[i]);
        return String(out);
    }

    static void genKeyPairHex(String& pub, String& priv) {
        uint8_t seed[32];
        for (int i = 0; i < 32; i++) seed[i] = random(0, 256);
        uint8_t pubkey[32];
        crypto_sign_public_key(pubkey, seed);
        char pubout[65];
        char privout[65];
        for (int i = 0; i < 32; i++) {
            sprintf(pubout + i * 2, "%02X", pubkey[i]);
            sprintf(privout + i * 2, "%02X", seed[i]);
        }
        pub = String(pubout);
        priv = String(privout);
    }

    static String genPairCode() {
        const char* alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        char code[7];
        for (int i = 0; i < 6; i++) code[i] = alphabet[random(0, 32)];
        code[6] = 0;
        return String(code);
    }

    void startAP(WebServer* server, DNSServer* dns) {
        String apSSID = "Espresso-" + nodeId;
        WiFi.mode(WIFI_AP);
        WiFi.softAP(apSSID.c_str());
        dns->start(53, "*", WiFi.softAPIP());
        server->begin();
    }

    void stopAP() {
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_STA);
    }

    bool connectSTA() {
        if (wifiSSID.isEmpty()) return false;
        WiFi.mode(WIFI_STA);
        WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
        unsigned long start = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(100);
        return WiFi.status() == WL_CONNECTED;
    }
};

extern Provision provision;
