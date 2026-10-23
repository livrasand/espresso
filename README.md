# Espresso

**Your Git forge. Even on an ESP32.**

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

## Get involved

Espresso is actively evolving. You can help make it more affordable, reliable, and accessible.

- Explore the source code.
- Report bugs and suggest features.
- Improve hardware compatibility and reliability.
- Contribute code, documentation, and testing.

See the repository's issues and contribution guidelines to get started.

## Hardware

Tested targets: ESP32. Test reports for other ESP32 variants are very welcome!

---

**Espresso**

*Your code. Your hardware. Your home.*
