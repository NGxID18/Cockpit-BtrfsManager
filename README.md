# Btrfs Manager for Cockpit

[![CI](https://github.com/NGxID18/Cockpit-BtrfsManager/actions/workflows/ci.yml/badge.svg)](https://github.com/NGxID18/Cockpit-BtrfsManager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Cockpit plugin for managing Btrfs storage pools, RAID profiles, subvolumes, Snapper backup schedules, and online maintenance tasks directly from the web console.

![Btrfs Manager pools overview](https://github.com/user-attachments/assets/152a34e7-13f9-412a-ab23-179de4d3240c)

*Pools overview showing member hardware, mount points, Data/Metadata RAID profiles, automatic backup status, drive errors.*

![Btrfs Manager pool details](https://github.com/user-attachments/assets/29639fa7-8270-4b97-9d1c-ae43c75e9463)

*Pool view with RAID conversion controls, `scrub`/`balance`/`defragment` execution, device health diagnostics, subvolumes, and snapshots.*

## Features

- Overview of active Btrfs pools with member disk models, mount points, dominant Data/Metadata profiles, usage meters, and `btrfs device stats` error indicators.
- Pool creation from unformatted, unmounted disks or partitions (`>= 256 MiB`) and online Data/Metadata profile conversion (`SINGLE`, `DUP`, `RAID0`, `RAID1`, `RAID10`).
- Subvolume listing and creation from the top-level tree (`subvolid=5`, including unmounted subvolumes), `+CoW`/`NoCoW` toggling via `chattr`, and deletion checks.
- Pool root snapshots, read-only flag toggling (`btrfs property set`), cloning snapshots into writable subvolumes, `hourly`/`daily`/`weekly` Snapper schedules with retention limits, and orphaned Snapper config cleanup.
- Online `btrfs scrub`, `btrfs balance`, and recursive `defragment` runs with live output and background status polling.
- Deletion guards blocking removal of the `/` OS pool, mounted subvolumes, or subvolumes referenced in `/etc/fstab`, plus pool-name confirmation before wiping drives.

## Requirements

Requires `cockpit`, `btrfs-progs` (`btrfsprogs` on openSUSE), `snapper`, `cron`/`cronie`, and `git`, alongside standard Linux base tools (`util-linux`, `e2fsprogs`, POSIX `awk`).

Tested distributions:

- **Debian / Ubuntu (`apt`)**: Debian 12 & 13, Ubuntu 24.04 LTS – 26.10
- **Fedora / AlmaLinux (`dnf`)**: Fedora 42 – 44, AlmaLinux 10
- **openSUSE (`zypper`)**: Leap 16, Tumbleweed
- **Arch Linux (`pacman`)**: Arch Linux, CachyOS

## Installation

### Installer Script

```bash
curl -sSL https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash
```

or with `wget`:

```bash
wget -qO- https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash
```

### Packages (GitHub Releases)

Pre-built `.deb` and `.rpm` packages are attached to [GitHub Releases](https://github.com/NGxID18/Cockpit-BtrfsManager/releases/latest):

- **Debian / Ubuntu (`apt`)**:
  ```bash
  sudo apt install ./cockpit-btrfs-manager_*_all.deb
  ```
- **Fedora / AlmaLinux (`dnf`)**:
  ```bash
  sudo dnf install ./cockpit-btrfs-manager-*.noarch.rpm
  ```
- **openSUSE (`zypper`)**:
  ```bash
  sudo zypper install --allow-unsigned-rpm ./cockpit-btrfs-manager-*.noarch.rpm
  ```

### Manual Setup

1. Install the 5 runtime packages:

   Debian / Ubuntu (`apt`):
   ```bash
   sudo apt-get update && sudo apt-get install -y --no-install-recommends cockpit btrfs-progs snapper cron git
   ```

   Fedora / AlmaLinux (`dnf`):
   ```bash
   sudo dnf install -y cockpit btrfs-progs snapper cronie git
   ```

   openSUSE (`zypper`):
   ```bash
   sudo zypper install --no-recommends -y cockpit btrfsprogs snapper cronie git
   ```

   Arch Linux (`pacman`):
   ```bash
   sudo pacman -S --needed cockpit btrfs-progs snapper cronie git
   ```

2. Enable system services:

   ```bash
   sudo mkdir -p /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly
   sudo systemctl enable --now cockpit.socket
   sudo systemctl enable --now cron.service 2>/dev/null || sudo systemctl enable --now crond.service 2>/dev/null || sudo systemctl enable --now cronie.service
   sudo systemctl enable --now snapper-cleanup.timer 2>/dev/null || true
   ```

3. Clone into `/usr/share/cockpit/btrfsmanager`:

   ```bash
   sudo mkdir -p /usr/share/cockpit
   sudo git clone --depth 1 https://github.com/NGxID18/Cockpit-BtrfsManager.git /usr/share/cockpit/btrfsmanager
   sudo chown -R root:root /usr/share/cockpit/btrfsmanager
   sudo chmod -R u=rwX,go=rX /usr/share/cockpit/btrfsmanager
   sudo chmod 755 /usr/share/cockpit/btrfsmanager/install.sh
   sudo git config --system --add safe.directory /usr/share/cockpit/btrfsmanager
   ```

Open Cockpit in your browser at `https://<ip>:9090` and select **Btrfs Manager** from the sidebar.

## Notes

- **Mounting and `/etc/fstab`**: Mount management and persistent `/etc/fstab` edits remain in Cockpit's native **Storage** page so mount units are not managed in two places.

## License

MIT — see [LICENSE](LICENSE).
