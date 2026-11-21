# BTRFS Manager for Cockpit

A lightweight, clean, and native web extension for **Cockpit** to manage BTRFS filesystems directly from your web browser.

No extra daemons or Node.js required — just a fast, responsive interface that talks directly to system CLI utilities via Cockpit.

---

## Features

* **Visual Storage Dashboard**: Overview of all BTRFS storage pools, member drives, RAID profiles, and space allocation bars.
* **Pool & RAID Management**: Format empty drives into new pools with custom Data and Metadata profiles (`Single`, `DUP`, `RAID 0`, `RAID 1`, `RAID 10`), or convert RAID profiles online.
* **Subvolumes**: Create nested subvolumes, toggle Copy-on-Write (`+CoW` / `NoCoW`), and delete unused subvolumes with built-in mount safety checks.
* **Snapshots & Restore**: Take instant snapshots, toggle `Read-Only` or `Writable`, and restore snapshots back into new folders.
* **Automated Backups**: Configure automatic snapshot retention schedules (`Hourly`, `Daily`, `Weekly`) powered by Snapper.
* **Drive Health & Maintenance**: One-click file corruption check & repair (`scrub`), space balancing, and defragmentation with live activity log.
* **OS Root Protection**: Hardened safety guards prevent accidental deletion of your host operating system drive (`/`).

---

## Tested Distributions

> [!NOTE]
> In theory, **any Linux distribution** can run this extension as long as the core dependencies (`cockpit`, `btrfs-progs`, `snapper`, `cronie`/`cron`, `util-linux`) are installed. 

The installer and extension have been tested on:

* **Debian Ecosystem (`apt`)**: Debian 12 & 13, Ubuntu 24.04 LTS to 26.10, Linux Mint (latest), Pop!_OS (latest)
* **Fedora & RHEL Ecosystem (`dnf`)**: Fedora 42 to 44, RHEL 10, Rocky Linux 10, AlmaLinux 10
* **openSUSE Ecosystem (`zypper`)**: openSUSE Leap 16, openSUSE Tumbleweed
* **Arch Linux Ecosystem (`pacman`)**: Arch Linux, Manjaro, CachyOS, EndeavourOS

---

## Quick Installation

Run either of the following commands as root. The script will automatically detect your distribution, install dependencies, and register the extension:

### Using curl:
```bash
curl -sSL https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash
```

### Using wget:
```bash
wget -qO- https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash
```

Once installed, open your browser at `https://<server-ip>:9090`, log in, and click **BTRFS Manager** in the left sidebar.

---

## Uninstallation

To remove BTRFS Manager and clean up scheduled backup jobs:

```bash
sudo /usr/share/cockpit/btrfsmanager/install.sh --uninstall
```

---

## Safety Notes

* **Mounting**: Drive mounting and `/etc/fstab` configuration are handled through Cockpit's native **Storage** page to prevent service conflicts.
* **Device Selection**: Only unallocated drives or partitions (>= 256 MiB) without active mount points or filesystems are shown when creating pools or adding drives.
* **Protected System Drive**: Pools containing the operating system root (`/`) cannot be deleted.
