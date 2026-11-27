# <img src="./web/openbin-mark.svg" width="32" height="32" style="vertical-align: middle;" /> Espresso

**Your Git forge. Even on an ESP32.**

<img width="1920" height="877" alt="Espresso Official Website" src="https://github.com/user-attachments/assets/6ec959f9-8dc0-4d2f-9bea-cc79682e50c6" />

Your projects deserve a home of their own.

Espresso makes self-hosted Git hosting accessible to more people. It brings repository hosting to affordable hardware, so you can keep your projects on your own devices without needing an expensive server or a cloud subscription.

Because owning your infrastructure shouldn't depend on how much you can afford.

## Your projects. Your hardware.

Not everyone can afford a dedicated server, a Raspberry Pi, or monthly cloud hosting. But an ESP32 and an SD card can be a much more accessible place to start.

Espresso turns that small device into part of your own Git hosting infrastructure, giving you another way to store and manage your projects.

- **Affordable by design.** Start with low-cost hardware instead of a dedicated server.
- **Your data, your devices.** Keep repository storage on hardware you control.
- **No server exposed to the internet.** Storage nodes connect outward, without requiring publicly accessible inbound ports.
- **One place for your projects.** Browse repositories and manage your connected storage nodes through the control plane.
- **Built for independence.** Reduce your reliance on centralized hosting services and recurring infrastructure costs.

## Small hardware. Bigger possibilities.

Espresso separates the place where you manage your projects from the devices that store them.

Your storage nodes can connect to the control plane from behind an ordinary home router, without requiring you to open inbound ports for each node. This makes experimenting with self-hosted Git more accessible, even on modest home networks.

As the project evolves, Espresso aims to make personal Git infrastructure practical for people who have traditionally been priced out of self-hosting.

## Private by design

Your infrastructure should work for you, not collect information about you.

Espresso uses account numbers instead of traditional usernames and passwords. Your account number is shown only once during registration, and the server stores its SHA-256 hash rather than the original number.

Sessions use signed authentication tokens, and the signing secret is supplied through environment configuration.

**Your account number is your key.** Keep it somewhere safe: you need it to sign in.

## Made for the open-source community

Espresso is an independent open-source project extracted from the gitGost Forge codebase.

It's for developers, students, hobbyists, and anyone who wants more control over where their code lives — regardless of their budget.

Whether you're experimenting with your first Git repository or exploring a different way to host your projects, Espresso is built around one simple idea: self-hosting should be more accessible.

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

**Espresso**

*Your code. Your hardware. Your home.*

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
