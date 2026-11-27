# <img src="./packages/node-server/public/openbin-mark.svg" width="32" height="32" style="vertical-align: middle;" /> Espresso

<img width="1920" height="877" alt="Espresso Official Website" src="https://github.com/user-attachments/assets/6ec959f9-8dc0-4d2f-9bea-cc79682e50c6" />

### Your code. Your hardware. Your freedom.

**What if your Git server could fit in your pocket?**

Espresso brings self-hosted Git hosting to affordable hardware. An ESP32, an SD card, and your own control plane are enough to start building your personal Git infrastructure.

No expensive servers. No cloud subscriptions. No publicly exposed storage nodes.

- **Affordable self-hosting.** Run Git storage on hardware that costs a fraction of a traditional server.
- **Your infrastructure, your rules.** Keep your repositories on devices you own and control.
- **No inbound ports.** Storage nodes connect outward, even behind ordinary home routers.
- **Private by design.** Account numbers instead of traditional usernames and passwords. Only SHA-256 hashes are stored.
- **Open and independent.** Build, experiment, extend, and make it your own.

Espresso separates repository management from storage, making it possible to build a distributed personal Git hosting setup without expensive infrastructure.

## Self-hosting shouldn't be a luxury.

Espresso is an independent open-source project extracted from [gitGost Forge](https://github.com/livrasand/gitGost), built for developers, students, hobbyists, and anyone who believes access to infrastructure shouldn't depend on their budget.

**An ESP32 can be more than a microcontroller. It can be part of your own Git infrastructure.**

If you believe in making self-hosting accessible to everyone, give Espresso a ⭐ on GitHub. Every star helps more developers discover the project.

## Getting started

### Connecting a node

*Requires a device with the Espresso firmware flashed (see `firmware/`).*

1. **Install the PlatformIO CLI** (skip if you already have `pio`):

   - **Windows / macOS / Linux (recommended, requires Python 3.7+):**
     ```bash
     pip install platformio
     ```
     On macOS you can also use Homebrew:
     ```bash
     brew install platformio
     ```
   - **Windows:** if `pio` is not found after installing, add Python's
     `Scripts` folder to your `PATH` (e.g. `%APPDATA%\\Python\\Python3x\\Scripts`).
   - **Linux:** if you get a permission error, install into your user site:
     ```bash
     pip install --user platformio
     ```
     and make sure `~/.local/bin` is on your `PATH`.
   - Alternatively, install the **PlatformIO IDE extension for VS Code**, which
     bundles the CLI and lets you flash from the editor.

   Verify the installation:
   ```bash
   pio --version
   ```

2. **Flash the firmware** (PlatformIO):

   ```bash
   cd firmware && pio run -t upload
   ```

   > **Troubleshooting uploads.** If `pio run -t upload` fails with serial errors
   > (`Invalid head of packet`, `No more data to read from the serial port`, …),
   > erase the flash and retry:
   > ```bash
   > cd firmware && pio run -t erase && pio run -t upload
   > ```
   > On noisy/long USB cables you can also make uploads more reliable by adding
   > `upload_speed = 115200` to `firmware/platformio.ini` (slower but stabler).

3. **First run — captive portal.** The node opens a WiFi access point named
   `Espresso-<nodeId>` (no password). Connect to it from your phone or laptop —
   the provisioning portal opens automatically (otherwise browse to
   `http://192.168.4.1`).

4. **Fill in the portal** and save:

   | Field  | Value |
   |--------|-------|
   | SSID   | Your WiFi network name |
   | Password | Your WiFi password |
   | Server | `espresso.livrasand.com` |
   | Port   | `443` |

   The settings are stored in NVS — no re-flashing is needed to change them.

5. **Pair the node.** After saving, the portal (and the serial log, 115200 baud)
   shows a **pair code**. Open <https://espresso.livrasand.com/dashboard>,
   click **Pair node**, enter the code, and the node will appear in your node
   list.

   > **Note:** It's normal for the node not to connect on the first try
   > sometimes. If it doesn't show up, refresh the page and try again —
   > that usually resolves it.

Nodes connect **outward** to the control plane — no inbound ports to open on
your router. **HTTPS is used when the provisioned port is 443**; any other port
speaks plain HTTP (handy for LAN/development against a local server).

To reprovision later (e.g. to change WiFi or server), hold the **BOOT button
(GPIO 0)** on the board for 5 seconds — provisioning is wiped and the setup
access point starts again.

The deployed control plane lives at:

| | URL | Port |
|---|-----|------|
| Web + API | `https://espresso.livrasand.com` | `443` (HTTPS) |

## <img src="https://cdn-icons-png.flaticon.com/512/2111/2111646.png" width="22" height="22" style="vertical-align: middle;" /> Telegram bot (optional)

Control your nodes from Telegram with **@espressoforgebot**:

1. Open the bot in Telegram and send `/start`.
2. Link your account with `/link <your_account_number>`.
3. Use the commands:

   | Command | Description |
   |---------|-------------|
   | `/nodes` | List your nodes |
   | `/repos <node>` | List repositories on a node |
   | `/create <node> <repo>` | Create a repository |
   | `/delete <node> <repo>` | Delete a repository |
   | `/ping <node>` | Ping a node |
   | `/status <node>` | Storage status |
   | `/restart <node>` | Restart a node |

   Your account number is shown only once at registration — keep it safe, it's
   the key to your node. Never share it in public chats.

## Hardware

Tested targets: ESP32. Test reports for other ESP32 variants are very welcome!

---

[![Share](https://img.shields.io/badge/share-000000?logo=x&logoColor=white)](https://x.com/intent/tweet?text=Check%20out%20this%20project%20on%20GitHub:%20https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-1877F2?logo=facebook&logoColor=white)](https://www.facebook.com/sharer/sharer.php?u=https://github.com/livrasand/espresso)
[![Share](https://custom-icon-badges.demolab.com/badge/share-0A66C2?logo=linkedin-white&logoColor=white)](https://www.linkedin.com/sharing/share-offsite/?url=https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-FF4500?logo=reddit&logoColor=white)](https://www.reddit.com/submit?title=Check%20out%20this%20project%20on%20GitHub:%20https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-0088CC?logo=telegram&logoColor=white)](https://t.me/share/url?url=https://github.com/livrasand/espresso&text=Check%20out%20this%20project%20on%20GitHub)
[![Share](https://img.shields.io/badge/share-0285FF?logo=bluesky&logoColor=white)](https://bsky.app/intent/compose?text=Check%20out%20Updainium:%20https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-6364FF?logo=mastodon&logoColor=white)](https://mastodonshare.com/?url=https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-FF6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/submitlink?u=https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-000000?logo=threads&logoColor=white)](https://www.threads.net/intent/post?text=Check%20out%20Updainium:%20https://github.com/livrasand/espresso)
[![Share](https://img.shields.io/badge/share-25D366?logo=whatsapp&logoColor=white)](https://wa.me/?text=Check%20out%20Updainium:%20https://github.com/livrasand/espresso)

*✨ Thanks for visiting **Espresso**!*

<img src="https://visitor-badge.laobi.icu/badge?page_id=livrasand.espresso&style=for-the-badge&color=f76f53" alt="Views">
