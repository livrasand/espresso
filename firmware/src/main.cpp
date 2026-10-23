// Espresso Node — ESP32 firmware
// Standalone (SD/USB) + auto-detected CH375B USB host + internal LittleFS fallback.
// PlatformIO / Arduino framework for ESP32.

#include "Arduino.h"
#include "config.h"
#include "ch375b.h"
#include "storage.h"
#include "protocol.h"
#include "provision.h"

// Global instances
CH375B      ch375b;
Storage     storage;
NodeProtocol node;
Provision   provision;

WebServer   gostServer(80);
DNSServer   gostDNS;

// ── Provisioning reset button ──────────────────────────
#define PROVISION_RESET_BUTTON 0
#define PROVISION_RESET_HOLD_MS 5000

static uint32_t provisionButtonPressedAt = 0;
static bool provisionResetTriggered = false;

// ── Captive portal HTML ───────────────────────────────
static const char PORTAL_HTML[] PROGMEM = R"rawliteral(
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Espresso Node Setup</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#1f1f1f;color:#d1cfc0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.wrap{width:100%;max-width:440px}
.brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1.5rem;justify-content:center}
.brand-dot{width:.5rem;height:.5rem;background:#f76f53}
.brand-name{font-size:1.5rem;font-weight:700;letter-spacing:-.02em}
.card{background:#121212;border:1px solid #2a2a2a;padding:1.5rem}
h1{font-size:.875rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#f76f53;margin-bottom:1.25rem}
label{display:block;font-size:.6875rem;font-family:ui-monospace,monospace;color:#888;margin:1rem 0 .25rem}
input{width:100%;background:#1f1f1f;border:1px solid #2a2a2a;color:#d1cfc0;padding:.5rem .6rem;font:inherit;font-size:.875rem;border-radius:0}
input:focus{outline:2px solid #f76f53;outline-offset:-2px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.hint{font-size:.625rem;color:#6b6b6b;margin-top:.25rem;line-height:1.4}
button{width:100%;margin-top:1.25rem;background:#f76f53;color:#1f1f1f;border:1px solid #f76f53;padding:.6rem;font-weight:600;cursor:pointer;font:inherit}
button:hover{background:#db573e;border-color:#db573e}
button.secondary{background:#121212;color:#d1cfc0;border:1px solid #2a2a2a}
button.secondary:hover{background:#2a2a2a}
.code{background:#1f1f1f;border:1px dashed #2a2a2a;padding:.75rem;text-align:center;font:1.25rem ui-monospace,monospace;letter-spacing:.15em;color:#22c55e;margin:.25rem 0}
.status{margin-top:.75rem;font-size:.75rem;color:#888}
.ok{color:#22c55e}
.error{color:#ef4444}
.footer{margin-top:1.5rem;text-align:center;font-size:.625rem;color:#6b6b6b;font-family:ui-monospace,monospace}
</style></head><body><div class="wrap">
<div class="brand"><span class="brand-dot"></span><span class="brand-name">Espresso</span></div>
<div class="card">
<h1>Node Setup</h1>
<div id="step1">
<label>WiFi SSID</label><input id="ssid" placeholder="MyWiFi">
<label>WiFi Password</label><input id="pass" type="password" placeholder="........">
<label>Forge URL</label><input id="server" placeholder="espresso.yourdomain.com">
<div class="row"><div><label>Port</label><input id="port" value="443"></div><div><label>Node name</label><input id="name" placeholder="desk-node"></div></div><span class="hint">Port 443 uses HTTPS; any other port speaks plain HTTP (LAN dev server).</span>
<label>Node ID</label><input id="nid" placeholder="auto">
<span class="hint">Leave empty to generate one automatically.</span>
<button onclick="save()">Save &amp; Generate keys</button>
</div>
<div id="step2" style="display:none">
<label>Pairing code</label><div class="code" id="code">---</div>
<label>Node ID</label><div class="code" id="nodeId">---</div>
<span class="hint">Enter the pairing code in the web UI or API. Node ID is used by the Node Protocol v2 polling client.</span>
<div class="status" id="status">Waiting for pairing...</div>
<button class="secondary" onclick="reset()">Reset</button>
</div>
</div>
<div class="footer">Espresso Node Protocol v2 . node dial-out</div>
</div><script>
function q(id){return document.getElementById(id)}
function save(){
  const ssid=q('ssid').value.trim();const pass=q('pass').value.trim();const server=q('server').value.trim();const port=parseInt(q('port').value||'443',10);const name=q('name').value.trim();const nid=q('nid').value.trim().toUpperCase();
  if(!ssid||!server){alert('SSID and server required');return}
  fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid,pass,server,port,name,nid})}).then(r=>r.json()).then(d=>{
    if(d.error){alert(d.error);return}
    q('step1').style.display='none';q('step2').style.display='block';
    document.title='Espresso - '+d.node_id;
    if(d.pair_code) document.getElementById('code').textContent=d.pair_code;
    if(d.node_id) document.getElementById('nodeId').textContent=d.node_id;
    pollStatus(d.node_id);
  })
}
function pollStatus(nid){
  const el=q('status');
  setInterval(()=>{fetch('/api/status?nid='+nid).then(r=>r.json()).then(d=>{
    if(d.paired){el.className='status ok';el.textContent='Paired! Restarting...';setTimeout(()=>location.reload(),2000)}
    else if(d.code){document.getElementById('code').textContent=d.code}
    if(d.node_id){document.getElementById('nodeId').textContent=d.node_id}
  })},1500)
}
function reset(){fetch('/api/reset',{method:'POST'}).then(()=>location.reload())}
</script></body></html>
)rawliteral";


// ── WiFi ──────────────────────────────────────────────
void wifiConnect() {
    if (WiFi.status() == WL_CONNECTED) return;

    log_i("WiFi connecting to %s", provision.wifiSSID.c_str());
    WiFi.mode(WIFI_STA);
    WiFi.begin(provision.wifiSSID.c_str(), provision.wifiPass.c_str());

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) {
        delay(100);
    }

    if (WiFi.status() == WL_CONNECTED) {
        log_i("WiFi connected  IP=%s  RSSI=%d dBm",
              WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        log_e("WiFi connection failed");
    }
}

void checkProvisionResetButton() {
    bool pressed = digitalRead(PROVISION_RESET_BUTTON) == LOW;

    if (pressed) {
        if (provisionButtonPressedAt == 0) {
            provisionButtonPressedAt = millis();
            log_i("BOOT button pressed — hold for 5 seconds to reset provisioning");
        }

        if (!provisionResetTriggered &&
            millis() - provisionButtonPressedAt >= PROVISION_RESET_HOLD_MS) {

            provisionResetTriggered = true;

            log_w("Resetting Espresso provisioning...");

            if (provision.reset()) {
                log_i("Provisioning reset successfully");
            } else {
                log_e("Failed to reset provisioning");
            }

            delay(500);
            ESP.restart();
        }
    } else {
        provisionButtonPressedAt = 0;
        provisionResetTriggered = false;
    }
}

// ── Storage health monitoring ────────────────────────
#define STORAGE_HEALTH_CHECK_INTERVAL_MS 30000  // check every 30s
#define STORAGE_REINIT_ON_FAILURE         true  // auto reinit if storage lost

static uint32_t lastStorageHealthCheck = 0;

void storageHealthCheck() {
    if (!storage.hasStorage()) {
        // No storage at all — try to re-detect
        if (STORAGE_REINIT_ON_FAILURE) {
            log_w("[HEALTH] No storage available — attempting re-detection...");
            storage.reinit();
        }
        return;
    }

    // Storage exists — verify it's still responsive
    bool sdWasOk  = storage.sdOk;
    bool usbWasOk = storage.usbOk;
    bool flashWasOk = storage.flashOk;

    // Quick liveness check: try to list root dir
    storage.listDir("/",
        [](const char* name, bool isDir, uint32_t size) {
            (void)name; (void)isDir; (void)size;
        }
    );

    if (sdWasOk && !storage.sdOk) {
        log_e("[HEALTH] SD card became unavailable — possible removal or corruption");
    }
    if (usbWasOk && !storage.usbOk) {
        log_e("[HEALTH] USB storage became unavailable — possible removal");
    }
    if (flashWasOk && !storage.flashOk) {
        log_e("[HEALTH] Internal Flash storage became unavailable — possible corruption");
    }

    // If all backends died, try full re-init
    if (!storage.sdOk && !storage.usbOk && !storage.flashOk) {
        log_e("[HEALTH] All storage backends lost!");
        if (STORAGE_REINIT_ON_FAILURE) {
            log_i("[HEALTH] Attempting full storage re-initialization...");
            storage.reinit();
        }
    }
}

// ── Setup ─────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(500);
    pinMode(PROVISION_RESET_BUTTON, INPUT_PULLUP);
    pinMode(LED_PROVISION_PIN, OUTPUT);
    digitalWrite(LED_PROVISION_PIN, LOW);
    log_i("\n=== Espresso node firmware  v%s (Node Protocol v2) ===", FIRMWARE_VERSION);

    // 1. Provisioning / NVS
    provision.begin();
    if (!provision.configured) {
        log_i("First run — starting provisioning AP");
        provision.nodeId = Provision::genNodeId();
        provision.pairCode = Provision::genPairCode();
        provision.startAP(&gostServer, &gostDNS);
        log_i("AP started: Espresso-%s, IP=%s", provision.nodeId.c_str(), WiFi.softAPIP().toString().c_str());
        log_i("Pair code: %s", provision.pairCode.c_str());
        // Web handlers
        gostServer.on("/", HTTP_GET, []() { gostServer.send(200, "text/html", PORTAL_HTML); });
        gostServer.on("/api/save", HTTP_POST, []() {
            String body = gostServer.arg("plain");
            JsonDocument doc;
            DeserializationError err = deserializeJson(doc, body);
            if (err) { gostServer.send(400, "application/json", "{\"error\":\"bad_json\"}"); return; }
            String ssid = doc["ssid"] | "";
            String pass = doc["pass"] | "";
            String server = doc["server"] | "";
            uint16_t port = doc["port"] | 443;
            String name = doc["name"] | "";
            String nid = doc["nid"] | "";
            if (nid.isEmpty()) nid = Provision::genNodeId();
            if (name.isEmpty()) name = "Espresso-node";
            String pubhex, privhex;
            Provision::genKeyPairHex(pubhex, privhex);
            provision.save(name, ssid, pass, server, port, "/node", nid, pubhex, privhex);
            provision.pairing = true;
            gostServer.send(200, "application/json", "{\"node_id\":\"" + nid + "\",\"pair_code\":\"" + provision.pairCode + "\"}");
            delay(3000);
            ESP.restart();
        });
        gostServer.on("/api/status", HTTP_GET, []() {
            String nid = gostServer.arg("nid");
            String out = "{\"paired\":false";
            if (provision.pairing && !provision.pairCode.isEmpty()) {
                out += ",\"code\":\"" + provision.pairCode + "\"";
                out += ",\"node_id\":\"" + provision.nodeId + "\"";
            }
            out += "}";
            gostServer.send(200, "application/json", out);
        });
        gostServer.on("/api/reset", HTTP_POST, []() {
            Preferences prefs;
            prefs.begin("Espresso", false);
            prefs.clear();
            prefs.end();
            gostServer.send(200, "application/json", "{\"ok\":true}");
            delay(500);
            ESP.restart();
        });
        return;
    }

    // 2. WiFi
    wifiConnect();

    // 3. Storage (SD → USB → Flash priority with fallback)
    storage.begin();

    // 4. Node protocol
    node.begin();
    node.connect();

    lastStorageHealthCheck = millis();
    log_i("setup complete — entering loop");
}

// ── Loop ──────────────────────────────────────────────
void loop() {
    checkProvisionResetButton();

    if (!provision.configured) {
        // Fast blink while waiting for provisioning
        static uint32_t lastBlink = 0;
        static bool ledOn = false;
        if (millis() - lastBlink >= LED_PROVISION_BLINK_MS) {
            lastBlink = millis();
            ledOn = !ledOn;
            digitalWrite(LED_PROVISION_PIN, ledOn ? HIGH : LOW);
        }
        gostDNS.processNextRequest();
        gostServer.handleClient();
        return;
    }

    digitalWrite(LED_PROVISION_PIN, LOW);

    // Reconnect WiFi if dropped
    if (WiFi.status() != WL_CONNECTED) {
        wifiConnect();
    }

    // Periodic storage health check (hot-plug detection)
    if (millis() - lastStorageHealthCheck > STORAGE_HEALTH_CHECK_INTERVAL_MS) {
        lastStorageHealthCheck = millis();
        storageHealthCheck();
    }

    // Run WebSocket + heartbeat
    node.loop();
}
