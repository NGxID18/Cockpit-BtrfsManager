/**
 * BTRFS Manager - Router & Action Controller
 * Dispatches user actions, coordinates background maintenance tasks,
 * enforces safety validations, and handles modal interactions.
 */

const {
  $,
  on,
  boxId,
  cmd,
  escapeHtml,
  parseSize,
  Sh,
  App,
  Modal,
  customAlert,
  customConfirm,
  customPrompt,
  customSelect,
} = window;

// --- State & Active Maintenance Timers ---
const activeScrubTimers = {};
const activeBalanceTimers = {};

/**
 * Discovers unallocated, non-mounted block devices eligible for pool creation or pool expansion.
 * Filters out partitions with existing filesystems, active mounts, zram, and devices smaller than 256 MiB.
 */
const getEmptyDevices = () =>
  cmd(["lsblk", "-J", "-o", "NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,RO"]).then((data) => {
    const extractEmpty = (devs) =>
      devs.reduce((acc, d) => {
        if (d.children?.length) return acc.concat(extractEmpty(d.children));
        const isRo = d.ro === true || d.ro === "1" || d.ro === 1;
        if (
          !d.fstype &&
          !d.mountpoint &&
          !isRo &&
          (d.type === "disk" || d.type === "part") &&
          !d.path.startsWith("/dev/zram") &&
          parseSize(d.size) >= 256 * 1024 * 1024
        ) {
          acc.push(d);
        }
        return acc;
      }, []);
    return extractEmpty(JSON.parse(data).blockdevices || []);
  });

// --- Maintenance Console & Background Monitoring ---

const setMaintBtn = (mnt, kind, isRunning) => {
  const bSafe = boxId(mnt);
  const isScrub = kind === "scrub";
  const btn = $(`btn-${isScrub ? "scrub" : "balance"}-${bSafe}`);
  if (!btn) return;

  const idleClass = isScrub ? "btn-primary" : "btn-secondary";
  btn.innerText = isRunning
    ? isScrub
      ? "Stop Check"
      : "Stop Optimization"
    : isScrub
      ? "Verify & Repair"
      : "Optimize Space";
  btn.classList.toggle("btn-danger", isRunning);
  btn.classList.toggle(idleClass, !isRunning);

  if (isRunning) btn.setAttribute("data-running", "true");
  else btn.removeAttribute("data-running");
};

const updateLiveStatus = (mnt, text) => {
  const bSafe = boxId(mnt);
  const b = $(`maint-console-${bSafe}`);
  if (!b) return;

  let liveEl = $(`term-live-${bSafe}`);
  if (!liveEl) {
    liveEl = document.createElement("div");
    liveEl.id = `term-live-${bSafe}`;
    liveEl.className = "term-line term-muted";
    b.appendChild(liveEl);
  }
  liveEl.innerHTML = `<span style="color:#60cdff; font-weight:600;">[Live Progress]</span>\n${escapeHtml(text)}`;
  b.scrollTop = b.scrollHeight;
};

const clearLiveStatus = (mnt) => $(`term-live-${boxId(mnt)}`)?.remove();

const setTermStatus = (mnt, text, isRunning = false) => {
  const badge = $(`term-status-${boxId(mnt)}`);
  if (badge) {
    badge.innerText = text;
    badge.className = "term-status-badge" + (isRunning ? " running" : "");
  }
};

const termLog = (mnt, text, type = "") => {
  const b = $(`maint-console-${boxId(mnt)}`);
  if (!b) return;

  const safeText = escapeHtml(text);
  const safeMnt = escapeHtml(mnt || "pool");
  const classMap = {
    status: "term-line term-muted",
    success: "term-line term-success",
    warn: "term-line term-warn",
    err: "term-line term-err",
  };

  if (type === "cmd") {
    b.innerHTML += `<div class="term-line"><span class="term-prompt">btrfs@${safeMnt}#</span> <span style="color:#e2e8f0; font-weight:600;">${safeText}</span></div>`;
  } else {
    b.innerHTML += `<div class="${classMap[type] || "term-line"}">${safeText}</div>`;
  }

  b.scrollTop = b.scrollHeight;
  while (b.childElementCount > 200) {
    if (b.firstElementChild.id?.startsWith("term-live-")) break;
    b.removeChild(b.firstElementChild);
  }
};

const startScrubMonitor = (mnt) => {
  if (activeScrubTimers[mnt]) clearInterval(activeScrubTimers[mnt]);
  activeScrubTimers[mnt] = setInterval(() => {
    cmd(["btrfs", "scrub", "status", "-d", mnt])
      .then((out) => {
        const isFinished =
          out.includes("finished") || out.includes("aborted") || out.includes("canceled");
        updateLiveStatus(mnt, out.trim());
        if (isFinished) {
          clearInterval(activeScrubTimers[mnt]);
          delete activeScrubTimers[mnt];
          clearLiveStatus(mnt);
          setMaintBtn(mnt, "scrub", false);
          setTermStatus(mnt, "Finished", false);
          termLog(mnt, "> Scrub operation complete!", "success");
        }
      })
      .catch(() => {});
  }, 2500);
};

/**
 * Monitors btrfs balance operations.
 * Note: btrfs balance status returns exit code 1 when balance is actively running.
 * Wrapping the command in shell with || true ensures non-zero exit does not reject the promise.
 */
const startBalanceMonitor = (mnt) => {
  if (activeBalanceTimers[mnt]) clearInterval(activeBalanceTimers[mnt]);
  activeBalanceTimers[mnt] = setInterval(() => {
    cmd(["sh", "-c", 'btrfs balance status "$1" 2>&1 || true', "--", mnt])
      .then((out) => {
        updateLiveStatus(mnt, out.trim());
        const isFinished =
          out.includes("No balance found") ||
          out.includes("finished") ||
          out.includes("Done") ||
          out.includes("aborted");

        if (isFinished) {
          clearInterval(activeBalanceTimers[mnt]);
          delete activeBalanceTimers[mnt];
          clearLiveStatus(mnt);
          setMaintBtn(mnt, "balance", false);
          setTermStatus(mnt, "Complete", false);
          termLog(mnt, "> Balance operation complete!", "success");
          App.fetch();
        }
      })
      .catch(() => {});
  }, 2500);
};

const checkBackgroundTasks = (mnt) => {
  if (!mnt) return;

  cmd(["btrfs", "scrub", "status", "-d", mnt])
    .then((out) => {
      if (out.includes("running")) {
        setMaintBtn(mnt, "scrub", true);
        setTermStatus(mnt, "Checking...", true);
        startScrubMonitor(mnt);
      }
    })
    .catch(() => {});

  // Handles btrfs balance status exit code 1 safely
  cmd(["sh", "-c", 'btrfs balance status "$1" 2>&1 || true', "--", mnt])
    .then((out) => {
      if (
        !out.includes("No balance found") &&
        !out.includes("finished") &&
        !out.includes("aborted") &&
        !out.includes("Done")
      ) {
        setMaintBtn(mnt, "balance", true);
        setTermStatus(mnt, "Optimizing...", true);
        startBalanceMonitor(mnt);
      }
    })
    .catch(() => {});
};

// --- RAID Profile Online Conversion Controller ---

const handleProfileConversion = (mnt, vIdx, isMeta) => {
  const v = App.vols.find((vol) => vol.idx == vIdx);
  const devCount = v?.devs?.length || 1;
  const alloc = isMeta ? v?.metaAlloc : v?.dataAlloc;
  const currentProf = alloc?.profile ? alloc.profile.toUpperCase() : isMeta ? "DUP" : "SINGLE";
  const label = isMeta ? "Metadata" : "Data";
  const flagPrefix = isMeta ? "-mconvert" : "-dconvert";

  const options = isMeta
    ? [
        {
          v: "dup",
          l: `DUP (Duplicate) - 2 redundant copies for corruption safety & self-healing (Recommended, Min 1 drive)${currentProf === "DUP" ? " [Current]" : ""}`,
        },
        {
          v: "single",
          l: `Single - Single copy of metadata (Saves space, Min 1 drive)${currentProf === "SINGLE" ? " [Current]" : ""}`,
        },
      ]
    : [
        {
          v: "single",
          l: `Single - Single copy of data files (Default, Min 1 drive)${currentProf === "SINGLE" ? " [Current]" : ""}`,
        },
        {
          v: "dup",
          l: `DUP (Duplicate) - 2 redundant copies of data on drive (Min 1 drive)${currentProf === "DUP" ? " [Current]" : ""}`,
        },
      ];

  if (!isMeta) {
    options.push({
      v: "raid0",
      l:
        devCount >= 2
          ? `RAID 0 (Stripe) - Max speed & total capacity, no redundancy (Min 2 drives)${currentProf === "RAID0" ? " [Current]" : ""}`
          : "RAID 0 (Stripe) - Max speed & total capacity (Requires 2+ drives)",
    });
  }

  options.push({
    v: "raid1",
    l:
      devCount >= 2
        ? `RAID 1 (Mirror) - Mirrored ${label.toLowerCase()} across separate drives (Min 2 drives)${currentProf === "RAID1" ? " [Current]" : ""}`
        : `RAID 1 (Mirror) - Mirrored ${label.toLowerCase()} across drives (Requires 2+ drives)`,
  });

  options.push({
    v: "raid10",
    l:
      devCount >= 4
        ? `RAID 10 - Striped and mirrored ${label.toLowerCase()} (Min 4 drives)${currentProf === "RAID10" ? " [Current]" : ""}`
        : `RAID 10 - Striped and mirrored ${label.toLowerCase()} (Requires 4+ drives)`,
  });

  customSelect(
    `Change ${label} Protection Level`,
    `Current ${label} Protection: ${currentProf} (${devCount} drive${devCount > 1 ? "s" : ""}).\nSelect ${label.toLowerCase()} protection mode to convert:`,
    options,
    `Apply ${label} Conversion`,
    (choice) => {
      if (!choice) return;
      if (currentProf.toLowerCase() === choice.toLowerCase()) {
        customAlert("Already Configured", `${label} protection is already set to ${currentProf} on this pool.`);
        return;
      }
      if ((choice === "raid0" || choice === "raid1") && devCount < 2) {
        customAlert("More Drives Needed", `${label} ${choice.toUpperCase()} requires at least 2 physical drives. Use "Add Drive" first.`);
        return;
      }
      if (choice === "raid10" && devCount < 4) {
        customAlert("More Drives Needed", `${label} RAID 10 requires at least 4 physical drives. Use "Add Drive" first.`);
        return;
      }

      termLog(mnt, `btrfs balance start --background -f ${flagPrefix}=${choice} ${mnt}`, "cmd");
      setTermStatus(mnt, "Converting...", true);
      setMaintBtn(mnt, "balance", true);

      cmd(["btrfs", "balance", "start", "--background", "-f", `${flagPrefix}=${choice}`, mnt])
        .then((o) => {
          termLog(mnt, `${label} conversion to ${choice.toUpperCase()} started in background.\n${o || "Started."}`, "status");
          startBalanceMonitor(mnt);
        })
        .catch((err) => {
          termLog(mnt, `${label} conversion failed: ${err.message}`, "err");
          setTermStatus(mnt, "Error", false);
          setMaintBtn(mnt, "balance", false);
        });
    },
  );
};

// --- Theme Controller ---

const updateThemeUi = (theme) => {
  const isDark = theme === "dark";
  if ($("theme-label")) $("theme-label").innerText = isDark ? "Light Theme" : "Dark Theme";
  if ($("theme-icon")) $("theme-icon").innerText = isDark ? "☀️" : "🌙";
  document.querySelectorAll(".theme-icon-sync").forEach((el) => {
    el.innerText = isDark ? "☀️" : "🌙";
  });
};

const initTheme = () => {
  const systemPrefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = localStorage.getItem("btrfs_manager_theme") || (systemPrefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeUi(theme);
};

const toggleTheme = () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const target = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", target);
  localStorage.setItem("btrfs_manager_theme", target);
  updateThemeUi(target);
};

// --- Event Dispatcher Initialization ---

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  App.fetch();

  // Delegated action click dispatcher
  document.body.addEventListener("click", (e) => {
    const tgt = e.target.closest(".btn-action");
    if (!tgt) return;

    const action = tgt.getAttribute("data-action");
    const mnt = tgt.getAttribute("data-mount");

    try {
      switch (action) {
        case "open-detail": {
          $("view-master").classList.add("hidden-element");
          $("view-detail").classList.remove("hidden-element");
          const idx = tgt.getAttribute("data-index");
          App.renderDetail(idx);
          const v = App.vols.find((vol) => vol.idx == idx);
          if (v?.mountPoint) checkBackgroundTasks(v.mountPoint);
          break;
        }

        case "quick-meta-dup": {
          customConfirm(
            "Upgrade Metadata to DUP (Duplicate)",
            `Convert metadata on ${mnt} from SINGLE to DUP?\n\nThis will safely create redundant duplicate copies of all filesystem metadata in the background for automatic corruption detection and self-healing.`,
            "Convert to DUP",
            () => {
              termLog(mnt, `btrfs balance start --background -f -mconvert=dup ${mnt}`, "cmd");
              setTermStatus(mnt, "Converting...", true);
              setMaintBtn(mnt, "balance", true);
              cmd(["btrfs", "balance", "start", "--background", "-f", "-mconvert=dup", mnt])
                .then((o) => {
                  termLog(mnt, `Metadata conversion to DUP started.\n${o || "Started."}`, "status");
                  startBalanceMonitor(mnt);
                })
                .catch((err) => {
                  termLog(mnt, `Metadata conversion failed: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                  setMaintBtn(mnt, "balance", false);
                });
            },
          );
          break;
        }

        case "convert-data":
          handleProfileConversion(mnt, tgt.getAttribute("data-index"), false);
          break;

        case "convert-metadata":
          handleProfileConversion(mnt, tgt.getAttribute("data-index"), true);
          break;

        case "scrub": {
          const scrubBtn = $(`btn-scrub-${boxId(mnt)}`);
          const isRunning = scrubBtn?.getAttribute("data-running") === "true";

          if (isRunning) {
            customConfirm("Stop Health Check", `Stop active scrub on ${mnt}?`, "Stop Check", () => {
              termLog(mnt, `btrfs scrub cancel ${mnt}`, "cmd");
              cmd(["btrfs", "scrub", "cancel", mnt])
                .then((o) => {
                  termLog(mnt, `Health check canceled: ${o}`, "warn");
                  if (activeScrubTimers[mnt]) {
                    clearInterval(activeScrubTimers[mnt]);
                    delete activeScrubTimers[mnt];
                  }
                  clearLiveStatus(mnt);
                  setMaintBtn(mnt, "scrub", false);
                  setTermStatus(mnt, "Canceled", false);
                })
                .catch((err) => termLog(mnt, `Error stopping scrub: ${err.message}`, "err"));
            }, true);
            return;
          }

          customConfirm(
            "Verify and Repair Files",
            `Check all files on ${mnt} for corruption and repair them automatically? This scan runs safely in the background while the storage is in active use.`,
            "Start Check",
            () => {
              termLog(mnt, `btrfs scrub start ${mnt}`, "cmd");
              setTermStatus(mnt, "Checking...", true);
              setMaintBtn(mnt, "scrub", true);

              cmd(["btrfs", "scrub", "start", mnt])
                .then(() => {
                  termLog(mnt, "> File health check initiated. Scanning in background...", "status");
                  startScrubMonitor(mnt);
                })
                .catch((err) => {
                  termLog(mnt, `Scrub failed to start: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                  setMaintBtn(mnt, "scrub", false);
                });
            },
          );
          break;
        }

        case "balance": {
          const balBtn = $(`btn-balance-${boxId(mnt)}`);
          const isRunning = balBtn?.getAttribute("data-running") === "true";

          if (isRunning) {
            customConfirm("Stop Storage Optimization", `Stop active optimization on ${mnt}?`, "Stop Optimization", () => {
              termLog(mnt, `btrfs balance cancel ${mnt}`, "cmd");
              cmd(["btrfs", "balance", "cancel", mnt])
                .then((o) => {
                  termLog(mnt, `Optimization canceled: ${o}`, "warn");
                  if (activeBalanceTimers[mnt]) {
                    clearInterval(activeBalanceTimers[mnt]);
                    delete activeBalanceTimers[mnt];
                  }
                  clearLiveStatus(mnt);
                  setMaintBtn(mnt, "balance", false);
                  setTermStatus(mnt, "Canceled", false);
                })
                .catch((err) => termLog(mnt, `Error stopping balance: ${err.message}`, "err"));
            }, true);
            return;
          }

          customConfirm(
            "Optimize Storage Space",
            `Reorganize and compact storage space on ${mnt}? This safely frees unallocated chunks and balances drive usage in the background without interrupting access.`,
            "Start Optimization",
            () => {
              termLog(mnt, `btrfs balance start --background -dusage=50 -musage=50 ${mnt}`, "cmd");
              setTermStatus(mnt, "Optimizing...", true);
              setMaintBtn(mnt, "balance", true);

              cmd(["btrfs", "balance", "start", "--background", "-dusage=50", "-musage=50", mnt])
                .then((out) => {
                  termLog(mnt, out || "Storage optimization running in background...", "status");
                  startBalanceMonitor(mnt);
                })
                .catch((err) => {
                  termLog(mnt, `Optimization failed: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                  setMaintBtn(mnt, "balance", false);
                });
            },
          );
          break;
        }

        case "defrag": {
          customConfirm(
            "Defragment Files",
            `Defragment files on ${mnt}? This organizes fragmented files to improve read speeds.\n\nNote: Defragmenting files shared with snapshots may unshare Copy-on-Write extents and increase space usage.`,
            "Start Defragmentation",
            () => {
              termLog(mnt, `btrfs filesystem defragment -r -v ${mnt}`, "cmd");
              setTermStatus(mnt, "Defragging...", true);

              const script = `
MNT="$1"
echo "> Initiating recursive defragmentation on $MNT..."
RAW=$(btrfs filesystem defragment -r -v "$MNT" 2>&1 || true)
TOTAL_LINES=$(echo "$RAW" | grep -c -v '^[[:space:]]*$' || true)
BUSY_COUNT=$(echo "$RAW" | grep -c "Text file busy" || true)

echo "$RAW" | head -n 25
if [ "$TOTAL_LINES" -gt 25 ]; then
  echo "... [Processed $(($TOTAL_LINES - 25)) more items]"
fi
echo "--------------------------------------------------"
if [ "$BUSY_COUNT" -gt 0 ]; then
  echo "> Defragmentation finished ($BUSY_COUNT active locked files skipped safely)."
else
  echo "> Defragmentation finished successfully with 0 errors."
fi
`;
              cmd(["sh", "-c", script, "--", mnt])
                .then((o) => {
                  termLog(mnt, o, "success");
                  setTermStatus(mnt, "Idle", false);
                })
                .catch((err) => {
                  termLog(mnt, `Defrag error: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                });
            },
          );
          break;
        }

        case "device-stats": {
          termLog(mnt, `btrfs device stats -T ${mnt}`, "cmd");
          cmd(["btrfs", "device", "stats", "-T", mnt])
            .then((out) => termLog(mnt, `[Physical Drive Diagnostics]\n${out}`, "status"))
            .catch((err) => termLog(mnt, `Diagnostics error: ${err.message}`, "err"));
          break;
        }

        case "clear-terminal": {
          const b = $(`maint-console-${tgt.getAttribute("data-box")}`);
          if (b) b.innerHTML = '<span class="term-muted">Console cleared. Ready for tasks.</span>';
          break;
        }

        case "remove-missing-dev": {
          customConfirm(
            "Remove Missing Drive",
            `Safely remove the disconnected or missing drive from ${mnt} and update the storage pool?`,
            "Remove Drive",
            () => {
              termLog(mnt, `btrfs device remove missing ${mnt}`, "cmd");
              setTermStatus(mnt, "Removing...", true);
              cmd(["btrfs", "device", "remove", "missing", mnt])
                .then((o) => {
                  termLog(mnt, `Missing drive removed successfully:\n${o}`, "success");
                  setTermStatus(mnt, "Idle", false);
                  App.fetch();
                })
                .catch((err) => {
                  termLog(mnt, `Drive removal error: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                });
            },
            true,
          );
          break;
        }

        case "remove-dev": {
          const devPath = tgt.getAttribute("data-devpath");
          customConfirm(
            "Remove Drive",
            `Safely evacuate all data off ${devPath} and remove it from ${mnt}?`,
            "Remove Drive",
            () => {
              termLog(mnt, `btrfs device remove ${devPath} ${mnt}`, "cmd");
              setTermStatus(mnt, "Removing...", true);
              cmd(["btrfs", "device", "remove", devPath, mnt])
                .then((o) => {
                  termLog(mnt, `Drive removed successfully:\n${o}`, "success");
                  setTermStatus(mnt, "Idle", false);
                  App.fetch();
                })
                .catch((err) => {
                  termLog(mnt, `Drive removal error: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                });
            },
            true,
          );
          break;
        }

        case "add-dev-modal":
          if (!$("add-dev-modal")) return;
          $("add-dev-modal").classList.remove("hidden-element");
          $("modal-mount-target").innerText = mnt;
          $("btn-confirm-add-dev").setAttribute("data-mount", mnt);
          $("btn-confirm-add-dev").disabled = true;
          $("modal-disk-select").innerHTML = `<option value="">Scanning for available drives...</option>`;

          getEmptyDevices()
            .then((devs) => {
              if (!devs.length) {
                $("modal-disk-select").innerHTML = `<option value="">No available empty drives found.</option>`;
              } else {
                $("modal-disk-select").innerHTML = devs
                  .map(
                    (d) => `<option value="${escapeHtml(d.path)}">${escapeHtml(d.path)} (${escapeHtml(d.size)} - Available)</option>`,
                  )
                  .join("");
                $("btn-confirm-add-dev").disabled = false;
              }
            })
            .catch((err) => {
              $("modal-disk-select").innerHTML = `<option value="">Error: ${escapeHtml(err.message)}</option>`;
            });
          break;

        case "destroy-vol-modal": {
          const mount = tgt.getAttribute("data-mount") || "";
          const uuid = tgt.getAttribute("data-uuid") || "";
          const label = tgt.getAttribute("data-label") || "Volume";
          const devs = tgt.getAttribute("data-devs") || "";

          if (mount === "/") {
            customAlert("Protected System Drive", "Cannot delete the host operating system root storage pool.");
            return;
          }

          $("destroy-vol-name").innerText = `${label} (${uuid})`;
          $("destroy-vol-devs").innerText = devs || "Member drives";

          const expectedText = label && !label.startsWith("Storage Pool (") ? label : "DELETE";
          $("destroy-vol-expected-text").innerText = expectedText;

          const confirmInput = $("destroy-vol-confirm-input");
          const execBtn = $("btn-execute-destroy-vol");
          confirmInput.value = "";
          execBtn.disabled = true;

          execBtn.setAttribute("data-mount", mount);
          execBtn.setAttribute("data-uuid", uuid);
          execBtn.setAttribute("data-devs", devs);
          execBtn.setAttribute("data-expected", expectedText);

          $("destroy-vol-modal").classList.remove("hidden-element");
          setTimeout(() => confirmInput.focus(), 80);
          break;
        }

        case "clean-orphaned-snaps": {
          if (!App.orphanedSnaps?.length) {
            customAlert("Notice", "No stale backup schedules found.");
            return;
          }

          const orphanNames = App.orphanedSnaps
            .map((o) => `• ${o.cfg} (Target: ${o.subvol || "Missing"})`)
            .join("\n");

          customConfirm(
            "Remove Stale Backup Schedules",
            `The following automatic backup schedules belong to drives or folders that have been deleted:\n\n${orphanNames}\n\nRemove these stale schedules to keep the backup service running smoothly?`,
            "Remove Schedules",
            () => {
              const script = `
${Sh.cleanSnapperFn}
for cfg in "$@"; do
  purge_snapper_cfg "$cfg"
done
echo "Cleaned"
`;
              const cfgs = App.orphanedSnaps.map((o) => o.cfg);
              cmd(["sh", "-c", script, "--", ...cfgs])
                .then(() => {
                  customAlert("Success", "All stale backup schedules have been removed cleanly.");
                  App.orphanedSnaps = [];
                  App.renderOrphanBanner();
                  App.fetch();
                })
                .catch((err) => customAlert("Error", "Failed to remove schedules: " + err.message));
            },
          );
          break;
        }

        case "subvol-ops": {
          const op = tgt.getAttribute("data-op");
          const p = tgt.getAttribute("data-path") || "";
          const i = tgt.getAttribute("data-index");
          const subId = tgt.getAttribute("data-subid") || "";

          const vClean =
            (mnt === "/"
              ? "root"
              : (mnt || "vol").replace(/\//g, "").replace(/[^a-zA-Z0-9]/g, "_")) || "vol";
          const sName = (dt) => (p ? `${p.split("/").pop()}_snap_${dt}` : `${vClean}_snap_${dt}`);

          if (op === "auto-snap") {
            if (!App.hasSnapper) {
              const script = `
if command -v dnf >/dev/null 2>&1; then echo "sudo dnf install snapper"
elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install snapper"
elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S snapper"
elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt install snapper"
else echo "Please install 'snapper' using your system package manager."
fi`;
              cmd(["sh", "-c", script])
                .then((cmdText) =>
                  customAlert(
                    "Snapper Required",
                    `The automated snapshot timeline feature requires the 'snapper' utility.\n\nInstall it on this server by running:\n${cmdText.trim()}\n\nAfter installation, reload Cockpit.`,
                  ),
                )
                .catch(() =>
                  customAlert("Snapper Required", "Please install 'snapper' on this server to enable automatic snapshots."),
                );
              return;
            }

            const targetName = p ? `/${p}` : mnt === "/" ? "Root Volume" : mnt;
            customSelect(
              "Automatic Backups",
              `Choose how often to take automatic backups for ${targetName}:`,
              [
                { v: "disable", l: "Turn Off Automatic Backups" },
                { v: "hourly", l: "Hourly Backups (Runs once every hour)" },
                { v: "daily", l: "Daily Backups (Runs once every day)" },
                { v: "weekly", l: "Weekly Backups (Runs once every week)" },
              ],
              "Next",
              (freq) => {
                if (!freq) return;
                const targetDir = p ? (mnt === "/" ? `/${p}` : `${mnt}/${p}`) : mnt;

                if (freq === "disable") {
                  const bashScript = `
TARGET="$1"
${Sh.cleanSnapperFn}
if ! command -v snapper >/dev/null 2>&1; then echo "ERROR: Snapper is not installed."; exit 1; fi
CFG_NAME=$(snapper list-configs 2>/dev/null | awk -v mnt="$TARGET" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
clean_target_cron "$TARGET" "$CFG_NAME"
if [ -n "$CFG_NAME" ] && [ "$CFG_NAME" != "Config" ] && [ "$CFG_NAME" != "root" ]; then
  purge_snapper_cfg "$CFG_NAME"
  echo "Automatic backups turned off successfully."
else
  echo "Backup schedule deactivated."
fi
`;
                  cmd(["sh", "-c", bashScript, "--", targetDir])
                    .then((out) => {
                      customAlert("Success", out);
                      App.fetch();
                    })
                    .catch((err) => customAlert("Error", err.message));
                } else {
                  customPrompt(
                    "Backup Retention Limit",
                    "How many recent backups do you want to keep?",
                    "5",
                    "Apply Schedule",
                    (limitStr) => {
                      if (!limitStr) return;
                      const limit = parseInt(limitStr, 10);
                      if (isNaN(limit) || limit < 1) {
                        customAlert("Error", "Please enter a valid number of backups to keep (e.g. 5).");
                        return;
                      }

                      // Create schedule with collision-free naming and openSUSE protection
                      const bashScript = `
MNT_PT="$1"
FREQ="$2"
LIMIT="$3"
${Sh.cleanSnapperFn}
if ! command -v snapper >/dev/null 2>&1; then
  echo "ERROR: Snapper is not installed."
  exit 1
fi

CFG_NAME=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT_PT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')

if [ -z "$CFG_NAME" ] || [ "$CFG_NAME" = "Config" ]; then
  if [ "$MNT_PT" = "/" ]; then
    CFG_NAME="root"
  else
    # Append path hash to prevent configuration collisions
    PATH_HASH=$(echo -n "$MNT_PT" | md5sum 2>/dev/null | cut -c1-4 || echo "vol")
    CFG_NAME="vol_$(basename "$MNT_PT" | tr -dc 'a-zA-Z0-9')_$PATH_HASH"
  fi

  SNAP_BAK=""
  if [ -d "$MNT_PT/.snapshots" ]; then
    SNAP_BAK="$MNT_PT/.snapshots.bak_$$"
    mv "$MNT_PT/.snapshots" "$SNAP_BAK" 2>/dev/null || true
  fi

  if ! snapper -c "$CFG_NAME" create-config "$MNT_PT"; then
    [ -n "$SNAP_BAK" ] && [ -d "$SNAP_BAK" ] && mv "$SNAP_BAK" "$MNT_PT/.snapshots" 2>/dev/null || true
    echo "ERROR: Failed to create backup config for $MNT_PT."
    exit 1
  fi

  if [ -n "$SNAP_BAK" ] && [ -d "$SNAP_BAK" ]; then
    for item in "$SNAP_BAK"/*; do
      [ -e "$item" ] && mv "$item" "$MNT_PT/.snapshots/" 2>/dev/null || true
    done
    btrfs subvolume delete "$SNAP_BAK" 2>/dev/null || rmdir "$SNAP_BAK" 2>/dev/null || true
  fi
fi

clean_target_cron "$MNT_PT" "$CFG_NAME"

snapper -c "$CFG_NAME" set-config TIMELINE_CREATE=no TIMELINE_CLEANUP=no NUMBER_CLEANUP=yes NUMBER_LIMIT="$LIMIT" NUMBER_MIN_AGE=0

mkdir -p "/etc/cron.$FREQ" 2>/dev/null || true
CRON_FILE="/etc/cron.$FREQ/btrfs_snap_$CFG_NAME"
cat << EOF > "$CRON_FILE"
#!/bin/sh
# Target: $MNT_PT
# Config: $CFG_NAME
# Frequency: $FREQ
# Limit: $LIMIT
if command -v snapper >/dev/null 2>&1; then
    snapper -c "$CFG_NAME" create -d "Auto ($FREQ)" -c number || true
    snapper -c "$CFG_NAME" cleanup number 2>/dev/null || true
fi
EOF
chmod 755 "$CRON_FILE"

systemctl enable --now snapper-cleanup.timer >/dev/null 2>&1 || true

printf "Automatic backups configured successfully!\\nFrequency: %s\\nRetention Limit: %s backups\\n" "$FREQ" "$LIMIT"
`;
                      cmd(["sh", "-c", bashScript, "--", targetDir, freq, String(limit)])
                        .then((out) => {
                          customAlert("Backups Configured", out);
                          App.fetch();
                        })
                        .catch((err) => customAlert("Error", err.message));
                    },
                  );
                }
              },
            );
          } else if (op === "create") {
            const rawInput = $(`new-subvol-${i}`)?.value.trim() || "";
            if (!rawInput) {
              customAlert("Input Required", "Please enter a subvolume name or path (e.g. 'data' or 'var/lib/machines').");
              return;
            }

            let pathStr = rawInput;
            const normalizedMnt = mnt.replace(/\/+$/, "");
            if (normalizedMnt && pathStr.startsWith(normalizedMnt + "/")) {
              pathStr = pathStr.slice(normalizedMnt.length);
            }
            pathStr = pathStr.replace(/^\/+/, "").replace(/\/+$/, "");

            const segments = pathStr.split("/").map((s) => s.trim()).filter(Boolean);
            if (!segments.length) {
              customAlert("Invalid Name", "Please enter a valid subvolume name or path.");
              return;
            }

            for (const seg of segments) {
              if (seg === "." || seg === ".." || seg.startsWith("-") || !/^[a-zA-Z0-9._-]+$/.test(seg)) {
                customAlert(
                  "Invalid Path Segment",
                  `Segment "${seg}" is invalid. Folder names may only contain letters, numbers, dots, dashes, and underscores, cannot start with "-", and cannot be "." or "..".`,
                );
                return;
              }
            }

            const cleanRelPath = segments.join("/");
            const targetPath = mnt === "/" ? `/${cleanRelPath}` : `${normalizedMnt}/${cleanRelPath}`;

            const script = `
TARGET="$1"
if btrfs subvolume show "$TARGET" >/dev/null 2>&1; then
  echo "ERROR: Subvolume '$TARGET' already exists." >&2
  exit 1
fi
if [ -L "$TARGET" ] || { [ -e "$TARGET" ] && [ ! -d "$TARGET" ]; }; then
  echo "ERROR: Target path '$TARGET' already exists and is a file or symlink." >&2
  exit 1
fi
PARENT=$(dirname "$TARGET")
if [ ! -d "$PARENT" ]; then
  mkdir -p "$PARENT" 2>/dev/null || { echo "ERROR: Failed to create parent directory '$PARENT'." >&2; exit 1; }
fi
if [ -d "$TARGET" ]; then
  if [ -z "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    rmdir "$TARGET" 2>/dev/null || { echo "ERROR: Could not prepare '$TARGET': unable to remove existing empty folder." >&2; exit 1; }
  else
    echo "ERROR: Target folder '$TARGET' already exists and is not empty." >&2
    exit 1
  fi
fi
ERR=$(btrfs subvolume create "$TARGET" 2>&1) || { echo "ERROR: $ERR" >&2; exit 1; }
echo "$ERR"
`;
            cmd(["sh", "-c", script, "--", targetPath])
              .then(() => {
                if ($(`new-subvol-${i}`)) $(`new-subvol-${i}`).value = "";
                App.fetchSubvols(mnt, i);
              })
              .catch((err) => customAlert("Creation Failed", err.message || String(err)));
          } else if (op === "del") {
            const isSnapshotContainer =
              p === ".snapshots" ||
              p === "@snapshots" ||
              p.endsWith("/.snapshots") ||
              p.endsWith("/@snapshots");

            if (isSnapshotContainer) {
              customAlert("Protected Snapshot Storage", "Cannot delete the snapshot storage folder.");
              return;
            }

            const mountedAt = tgt.getAttribute("data-mounted-at") || "";
            const isProtected =
              tgt.getAttribute("data-is-protected") === "true" ||
              Boolean(mountedAt) ||
              (mnt === "/" && (p === "@" || p === "" || p === "root" || p === "rootfs" || p === "@root"));

            if (isProtected) {
              customAlert("Active System Folder", `This subvolume is currently mounted at "${mountedAt || "/"}" and cannot be deleted.`);
              return;
            }

            customConfirm(
              "Delete Subvolume / Snapshot",
              `Are you sure you want to permanently delete "${p}"? All files inside will be permanently erased.`,
              "Delete",
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
SUB_ID="$3"

if echo "$SUB_PATH" | grep -q -E "(^|/)\\.snapshots/([0-9]+)/snapshot$"; then
  SNAP_NUM=$(echo "$SUB_PATH" | sed -n -E "s/.*\\.snapshots\\/([0-9]+)\\/snapshot$/\\1/p")
  if [ -n "$SNAP_NUM" ] && command -v snapper >/dev/null 2>&1; then
    CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
    if [ -n "$CFG" ] && [ "$CFG" != "Config" ] && snapper -c "$CFG" delete "$SNAP_NUM" 2>/dev/null; then
      echo "Deleted via Snapper"
      exit 0
    fi
  fi
fi

FOUND_MOUNT=$(findmnt -n -l -o TARGET,SOURCE -t btrfs 2>/dev/null | grep -v "^/tmp" | while read -r t_m s_m; do
  s_in=$(echo "$s_m" | sed -n "s/.*\\[\\/*\\(.*\\)\\]/\\1/p")
  if [ -n "$s_in" ] && [ "$s_in" = "$SUB_PATH" ]; then
    echo "$t_m"
    break
  fi
done)

if [ -n "$FOUND_MOUNT" ]; then
  echo "ERROR: Subvolume is actively mounted on $FOUND_MOUNT. Deletion blocked."
  exit 1
fi

${Sh.mountTopLevel}

if in_fstab "$SUB_PATH"; then
  echo "ERROR: Subvolume is referenced in /etc/fstab. Deletion blocked."
  exit 1
fi

DELETED=0
LAST_ERR=""
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SUB_PATH" ]; then
  ERR=$(btrfs subvolume delete "$TMP/$SUB_PATH" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
fi

if [ "$DELETED" -eq 0 ]; then
  if [ -e "$MNT/$SUB_PATH" ]; then
    ERR=$(btrfs subvolume delete "$MNT/$SUB_PATH" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
  elif [ "$MNT" = "/" ] && [ -e "/$SUB_PATH" ]; then
    # Strictly allow root delete ONLY if the current pool is root
    ERR=$(btrfs subvolume delete "/$SUB_PATH" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
  elif [ -n "$SUB_ID" ]; then
    ERR=$(btrfs subvolume delete -i "$SUB_ID" "$MNT" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
  fi
fi

if [ "$DELETED" -eq 1 ]; then
  echo "Deleted"
  exit 0
else
  echo "Failed to delete subvolume '$SUB_PATH': \${LAST_ERR:-Unknown error}"
  exit 1
fi
`;
                cmd(["sh", "-c", script, "--", mnt, p, subId])
                  .then(() => App.fetchSubvols(mnt, i))
                  .catch((err) => customAlert("Failed", err.message));
              },
              true,
            );
          } else if (op === "clone-snap") {
            const snapBase = p.split("/").pop();
            customPrompt(
              "Restore Snapshot as Writable",
              "Enter a name for the restored folder (will be created with normal read-write access):",
              `${snapBase}_restored`,
              "Restore Folder",
              (newSubvolName) => {
                if (!newSubvolName) return;
                const cleanSubvol = newSubvolName
                  .trim()
                  .replace(/[^a-zA-Z0-9._-]/g, "")
                  .replace(/^-+/, "");

                if (!cleanSubvol) {
                  customAlert("Error", "Please enter a valid folder name (letters, numbers, dashes, underscores).");
                  return;
                }

                const script = `
MNT="$1"
SNAP_PATH="$2"
NEW_NAME="$3"
${Sh.mountTopLevel}

DEST_PATH="$MNT/$NEW_NAME"
[ "$MNT" = "/" ] && DEST_PATH="/$NEW_NAME"

if [ -e "$DEST_PATH" ]; then
  echo "ERROR: Destination path '$DEST_PATH' already exists."
  exit 1
fi

SRC_PATH=""
if [ -e "$MNT/$SNAP_PATH" ] && btrfs subvolume show "$MNT/$SNAP_PATH" >/dev/null 2>&1; then
  SRC_PATH="$MNT/$SNAP_PATH"
elif [ "$MNT" = "/" ] && [ -e "/$SNAP_PATH" ] && btrfs subvolume show "/$SNAP_PATH" >/dev/null 2>&1; then
  SRC_PATH="/$SNAP_PATH"
elif [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SNAP_PATH" ]; then
  SRC_PATH="$TMP/$SNAP_PATH"
fi

if [ -z "$SRC_PATH" ]; then
  echo "ERROR: Could not locate snapshot source '/$SNAP_PATH'."
  exit 1
fi

ERR=$(btrfs subvolume snapshot "$SRC_PATH" "$DEST_PATH" 2>&1) || { echo "ERROR: $ERR"; exit 1; }
echo "Snapshot restored successfully to $DEST_PATH"
`;
                cmd(["sh", "-c", script, "--", mnt, p, cleanSubvol])
                  .then((out) => {
                    customAlert("Restore Successful", out);
                    App.fetchSubvols(mnt, i);
                  })
                  .catch((err) => customAlert("Restore Failed", err.message));
              },
            );
          } else if (op === "toggle-ro") {
            const targetRo = tgt.getAttribute("data-ro") === "true";
            const actionWord = targetRo ? "Protect as Read-Only" : "Make Writable";

            customConfirm(
              actionWord,
              `Change "/${p}" to ${targetRo ? "Read-Only" : "Writable"}?`,
              actionWord,
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
VAL="$3"
${Sh.mountTopLevel}

if ! resolve_subvol_path "$SUB_PATH"; then
  echo "ERROR: Subvolume '/$SUB_PATH' not found." >&2
  exit 1
fi
btrfs property set "$TARGET_PATH" ro "$VAL"
`;
                cmd(["sh", "-c", script, "--", mnt, p, targetRo ? "true" : "false"])
                  .then(() => {
                    customAlert("Success", `Subvolume /${p} permission changed to ${targetRo ? "Read-Only" : "Read-Write"}.`);
                    App.fetchSubvols(mnt, i);
                  })
                  .catch((err) => customAlert("Error", "Failed to change property: " + err.message));
              },
            );
          } else if (op.startsWith("snap")) {
            const snapPromptTitle = p
              ? `Take Snapshot (/${p})`
              : mnt === "/"
                ? "Take System Snapshot (/)"
                : `Take Pool Snapshot (${mnt})`;

            customPrompt(
              snapPromptTitle,
              "Backup Name:",
              sName(new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)),
              "Take Snapshot",
              (n) => {
                if (!n) return;
                const cleanName = n.trim().replace(/[^a-zA-Z0-9._-]/g, "").replace(/^-+/, "");

                if (!cleanName) {
                  customAlert("Error", "Please enter a valid backup name (letters, numbers, dashes, underscores).");
                  return;
                }

                const script = `
MNT="$1"
SUB_PATH="$2"
DEST="$3"
${Sh.mountTopLevel}

TARGET_SRC=""
if [ -n "$SUB_PATH" ]; then
  if [ -d "$MNT/$SUB_PATH" ] && btrfs subvolume show "$MNT/$SUB_PATH" >/dev/null 2>&1; then
    TARGET_SRC="$MNT/$SUB_PATH"
  elif [ "$MNT" = "/" ] && [ -d "/$SUB_PATH" ] && btrfs subvolume show "/$SUB_PATH" >/dev/null 2>&1; then
    TARGET_SRC="/$SUB_PATH"
  fi
fi

if [ -z "$TARGET_SRC" ]; then
  if btrfs subvolume show "$MNT" >/dev/null 2>&1; then
    TARGET_SRC="$MNT"
  else
    FSROOT_DETECT=$(findmnt -n -o FSROOT -T "$MNT" 2>/dev/null | head -n 1 | sed 's|^/||')
    if [ -n "$FSROOT_DETECT" ] && [ "$FSROOT_DETECT" != "root" ] && [ -d "$MNT/$FSROOT_DETECT" ] && btrfs subvolume show "$MNT/$FSROOT_DETECT" >/dev/null 2>&1; then
      TARGET_SRC="$MNT/$FSROOT_DETECT"
    else
      TARGET_SRC="$MNT"
    fi
  fi
fi

SNAP_DONE=0
ERROR_MSG=""

if [ "$IS_MOUNTED" -eq 1 ]; then
  FSROOT_RAW=$(findmnt -n -o FSROOT -T "$TARGET_SRC" 2>/dev/null | head -n 1 | sed 's|^/||')
  SRC_IN_POOL=""
  if [ -n "$FSROOT_RAW" ] && [ -e "$TMP/$FSROOT_RAW" ]; then
    SRC_IN_POOL="$TMP/$FSROOT_RAW"
  elif [ -n "$SUB_PATH" ] && [ -e "$TMP/$SUB_PATH" ]; then
    SRC_IN_POOL="$TMP/$SUB_PATH"
  fi

  if [ -n "$SRC_IN_POOL" ]; then
    ERR=$(btrfs subvolume snapshot "$SRC_IN_POOL" "$TMP/$DEST" 2>&1) && SNAP_DONE=1 || ERROR_MSG="$ERR"
  else
    ERR=$(btrfs subvolume snapshot "$TARGET_SRC" "$TMP/$DEST" 2>&1) && SNAP_DONE=1 || ERROR_MSG="$ERR"
  fi
fi

if [ "$SNAP_DONE" -eq 0 ]; then
  SNAP_DIR="$MNT/.snapshots"
  [ "$MNT" = "/" ] && SNAP_DIR="/.snapshots"
  if [ ! -d "$SNAP_DIR" ]; then
    btrfs subvolume create "$SNAP_DIR" >/dev/null 2>&1 || mkdir -p "$SNAP_DIR" 2>/dev/null || SNAP_DIR="$MNT"
  fi
  ERR=$(btrfs subvolume snapshot "$TARGET_SRC" "$SNAP_DIR/$DEST" 2>&1) && SNAP_DONE=1 || ERROR_MSG="$ERR"
fi

if [ "$SNAP_DONE" -eq 1 ]; then
  echo "Success"
  exit 0
else
  echo "ERROR: \${ERROR_MSG:-Failed to create snapshot. Ensure volume is mounted read-write.}"
  exit 1
fi
`;
                cmd(["sh", "-c", script, "--", mnt, p, cleanName])
                  .then(() => App.fetchSubvols(mnt, i))
                  .catch((err) => customAlert("Snapshot Failed", err.message));
              },
            );
          } else if (op === "disable-cow" || op === "enable-cow") {
            const isDisable = op === "disable-cow";
            const flag = isDisable ? "+C" : "-C";
            const actionWord = isDisable ? "Turn Off CoW (High-Speed Mode)" : "Turn On CoW (Data Protection)";
            const noteMsg = isDisable
              ? "Turning off Copy-on-Write (NoCoW) improves performance for database files and virtual machines. Applies to new files created in this folder."
              : "Turning on Copy-on-Write provides automatic checksum verification, corruption healing, and snapshot efficiency.";

            customConfirm(
              actionWord,
              `${isDisable ? "Turn off" : "Turn on"} Copy-on-Write for "/${p}"?\n\n${noteMsg}`,
              isDisable ? "Turn Off CoW" : "Turn On CoW",
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
FLAG="$3"
${Sh.mountTopLevel}

if ! resolve_subvol_path "$SUB_PATH"; then
  echo "ERROR: Subvolume '/$SUB_PATH' not found." >&2
  exit 1
fi
chattr "$FLAG" "$TARGET_PATH"
`;
                cmd(["sh", "-c", script, "--", mnt, p, flag])
                  .then(() => {
                    customAlert("Success", `Copy-on-Write successfully ${isDisable ? "disabled" : "enabled"} for /${p}`);
                    App.fetchSubvols(mnt, i);
                  })
                  .catch((err) => customAlert("Error", "Failed to modify folder attributes: " + err.message));
              },
            );
          } else if (op === "purge-snaps") {
            customConfirm(
              "Clean Up Old Backups",
              "Remove older automatic snapshots that exceed your backup retention limit to free up storage space?",
              "Clean Up Now",
              () => {
                const bashScript = `
TARGET="$1"
if command -v snapper >/dev/null 2>&1; then
  CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$TARGET" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
  if [ -n "$CFG" ] && [ "$CFG" != "Config" ]; then
    snapper -c "$CFG" cleanup timeline
    snapper -c "$CFG" cleanup number
    echo "Old backups cleaned up successfully."
  else
    echo "No backup configuration found for this storage pool."
  fi
else
  echo "Backup utility (Snapper) is not installed."
fi
`;
                termLog(mnt, `snapper cleanup timeline on ${mnt}`, "cmd");
                cmd(["sh", "-c", bashScript, "--", mnt])
                  .then((o) => {
                    termLog(mnt, o, "success");
                    App.fetch();
                  })
                  .catch((err) => termLog(mnt, `Cleanup error: ${err.message}`, "err"));
              },
            );
          }
          break;
        }
      }
    } catch (err) {
      customAlert("Execution Error", err.message);
    }
  });

  // Modal event bindings
  on("generic-modal-cancel", "click", () => Modal.close());
  on("generic-modal-confirm", "click", () => Modal.confirm());
  on("btn-back-master", "click", () => {
    $("view-detail").classList.add("hidden-element");
    $("view-master").classList.remove("hidden-element");
    $("detail-container").setAttribute("data-active-index", "");
  });
  on("btn-close-add-modal", "click", () => $("add-dev-modal").classList.add("hidden-element"));

  // Add device confirmation
  on("btn-confirm-add-dev", "click", (e) => {
    const mnt = e.target.getAttribute("data-mount");
    const newDev = $("modal-disk-select").value;
    if (!newDev) return;

    $("add-dev-modal").classList.add("hidden-element");
    termLog(mnt, `btrfs device add -f ${newDev} ${mnt}`, "cmd");
    setTermStatus(mnt, "Adding...", true);

    cmd(["btrfs", "device", "add", "-f", newDev, mnt])
      .then((o) => {
        termLog(mnt, `Device ${newDev} added successfully.\n${o}`, "success");
        setTermStatus(mnt, "Idle", false);
        App.fetch();
      })
      .catch((err) => {
        termLog(mnt, `Failed to add device: ${err.message}`, "err");
        setTermStatus(mnt, "Error", false);
      });
  });

  // Pool creation form toggling
  on("btn-create-raid", "click", () => {
    $("raid-form").classList.remove("hidden-element");
    $("format-status").classList.add("hidden-element");
    $("available-disks").innerHTML = "Scanning block devices...";

    getEmptyDevices()
      .then((devs) => {
        $("available-disks").innerHTML =
          devs
            .map(
              (d) =>
                `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="${escapeHtml(d.path)}"> <span class="btrfs-code">${escapeHtml(d.path)}</span> - Size: ${escapeHtml(d.size)}</label>`,
            )
            .join("") || "<span class='text-danger'>No available empty drives found.</span>";
        $("btn-execute-format").disabled = !devs.length;
      })
      .catch((err) => {
        $("available-disks").innerHTML = `Scan failed: ${escapeHtml(err.message)}`;
      });
  });

  // Delete pool confirmation input matching
  on("destroy-vol-confirm-input", "input", (e) => {
    const expected = $("btn-execute-destroy-vol").getAttribute("data-expected");
    $("btn-execute-destroy-vol").disabled = e.target.value.trim() !== expected;
  });

  on("btn-cancel-destroy-vol", "click", () => $("destroy-vol-modal").classList.add("hidden-element"));

  // Execute pool deletion
  on("btn-execute-destroy-vol", "click", (e) => {
    const mount = e.target.getAttribute("data-mount") || "";
    const uuid = e.target.getAttribute("data-uuid") || "";
    const devs = (e.target.getAttribute("data-devs") || "").split(/\s+/).filter(Boolean);

    $("destroy-vol-modal").classList.add("hidden-element");

    if (mount && activeScrubTimers[mount]) {
      clearInterval(activeScrubTimers[mount]);
      delete activeScrubTimers[mount];
    }
    if (mount && activeBalanceTimers[mount]) {
      clearInterval(activeBalanceTimers[mount]);
      delete activeBalanceTimers[mount];
    }

    const script = `
MNT="$1"
UUID="$2"
shift 2
${Sh.cleanSnapperFn}

if command -v snapper >/dev/null 2>&1 && [ -n "$MNT" ]; then
  CFGS=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" 'NR>2 && ($3 == mnt || index($3, mnt"/") == 1) {print $1}')
  for cfg in $CFGS; do
    purge_snapper_cfg "$cfg"
  done
fi

for cfg_file in /etc/snapper/configs/*; do
  [ -f "$cfg_file" ] || continue
  cfg_name=$(basename "$cfg_file")
  [ "$cfg_name" = "root" ] && continue
  subvol=$(grep -E "^SUBVOLUME=" "$cfg_file" 2>/dev/null | cut -d'=' -f2 | tr -d '"'"'")
  if [ -n "$subvol" ] && [ -n "$MNT" ] && { [ "$subvol" = "$MNT" ] || [ "\${subvol#"$MNT"/}" != "$subvol" ]; }; then
    purge_snapper_cfg "$cfg_name"
  fi
done

if [ -n "$MNT" ] && [ "$MNT" != "/" ]; then
  clean_target_cron "$MNT" ""
  umount -R "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null || true
fi

if [ -n "$UUID" ]; then
  findmnt -n -o TARGET -t btrfs --source "UUID=$UUID" 2>/dev/null | while read -r t; do
    [ -n "$t" ] && [ "$t" != "/" ] && { umount -R "$t" 2>/dev/null || umount -l "$t" 2>/dev/null || true; }
  done
fi

for dev in "$@"; do
  [ -b "$dev" ] && { wipefs -a -f "$dev" 2>/dev/null || true; }
done

MATCH=0
if [ -n "$UUID" ] && grep -qsF "$UUID" /etc/fstab; then MATCH=1; fi
if [ -n "$MNT" ] && [ "$MNT" != "/" ] && awk -v m="$MNT" '!/^[[:space:]]*#/ && $2 == m {found=1; exit} END {exit !found}' /etc/fstab 2>/dev/null; then MATCH=1; fi
[ "$MATCH" -eq 1 ] && echo "FSTAB_YES" || echo "FSTAB_NO"
`;

    cmd(["sh", "-c", script, "--", mount, uuid, ...devs])
      .then((out) => {
        const hasFstab = (out || "").trim().endsWith("FSTAB_YES");
        customAlert(
          hasFstab ? "Storage Pool Deleted - Notice" : "Storage Pool Deleted",
          hasFstab
            ? "The storage pool was deleted and member drives were wiped.\n\nImportant: An entry matching this storage pool was detected in /etc/fstab. Remember to comment out or remove this entry to avoid boot delays."
            : "The storage pool and all automatic backup schedules were removed. Member drives have been wiped and are now available.",
        );
        $("view-detail").classList.add("hidden-element");
        $("view-master").classList.remove("hidden-element");
        $("detail-container").setAttribute("data-active-index", "");
        App.fetch();
      })
      .catch((err) => {
        customAlert("Error Deleting Pool", err.message);
        App.fetch();
      });
  });

  on("btn-cancel-format", "click", () => $("raid-form").classList.add("hidden-element"));
  on("btn-refresh", "click", () => App.fetch());

  on("raid-profile", "change", (e) => {
    const prof = e.target.value;
    const metaSelect = $("meta-profile");
    if (!metaSelect) return;
    metaSelect.value = prof === "raid1" || prof === "raid10" ? prof : "dup";
  });

  // Execute pool format & creation
  on("btn-execute-format", "click", () => {
    const disks = Array.from(document.querySelectorAll('input[name="tgt-disk"]:checked')).map((cb) => cb.value);
    const prof = $("raid-profile").value;
    const metaProf = $("meta-profile")?.value || "dup";
    const lbl = $("volume-label").value.trim();
    const statusEl = $("format-status");

    if (!disks.length) {
      statusEl.innerText = "Error: Please select at least one drive!";
      statusEl.classList.remove("hidden-element");
      statusEl.style.color = "var(--danger)";
      return;
    }

    // Label length validation (BTRFS labels cannot exceed 255 bytes)
    if (lbl.length > 255 || /[\r\n\t]/.test(lbl)) {
      customAlert("Invalid Label", "Pool name cannot exceed 255 characters and cannot contain control characters.");
      return;
    }

    const checkMinDrives = (p, kind) => {
      const min = p === "raid10" ? 4 : p === "raid0" || p === "raid1" ? 2 : 1;
      if (disks.length < min) {
        customAlert("More Drives Needed", `The ${kind} ${p.toUpperCase()} profile requires at least ${min} drive(s). You selected ${disks.length}.`);
        return false;
      }
      return true;
    };

    if (!checkMinDrives(prof, "data") || !checkMinDrives(metaProf, "metadata")) return;

    customConfirm(
      "Format Drives & Create Storage Pool",
      `Are you sure you want to format ${disks.length} drive(s) into a new storage pool?\n\n• Data Profile: ${prof.toUpperCase()}\n• Metadata Profile: ${metaProf.toUpperCase()}\n• Drives: ${disks.join(", ")}\n\nWARNING: All files on these drives will be permanently erased.`,
      "Format & Create Pool",
      () => {
        const c = ["mkfs.btrfs", "-d", prof, "-m", metaProf, "-f"];
        if (lbl) c.push("-L", lbl);
        c.push(...disks);

        statusEl.classList.remove("hidden-element");
        statusEl.style.color = "var(--accent)";
        statusEl.innerText = "> Formatting drives and creating storage pool...";
        $("btn-execute-format").disabled = true;

        cmd(c)
          .then(() => {
            statusEl.style.color = "var(--success-text)";
            statusEl.innerText = "Success! Storage pool created successfully.";
            App.fetch();
            setTimeout(() => {
              $("raid-form").classList.add("hidden-element");
              $("btn-execute-format").disabled = false;
            }, 2500);
          })
          .catch((err) => {
            statusEl.style.color = "var(--danger)";
            statusEl.innerText = "Creation failed:\n" + err.message;
            $("btn-execute-format").disabled = false;
          });
      },
      true,
    );
  });

  on("btn-toggle-theme", "click", toggleTheme);
  on("btn-toggle-theme-detail", "click", toggleTheme);

  on("btn-refresh-detail", "click", () => {
    const activeIdx = $("detail-container")?.getAttribute("data-active-index");
    App.fetch().then(() => {
      if (activeIdx !== null && activeIdx !== "") App.renderDetail(activeIdx);
    });
  });

  // Self-update routine via official repository
  on("btn-update-extension", "click", () => {
    customConfirm(
      "Update BTRFS Manager Extension",
      "Update the extension to the latest version from the official GitHub repository?\n\nThe interface will reload once updated.",
      "Update Now",
      () => {
        customAlert("Updating Extension", "Downloading latest release from GitHub repository...");
        const updateScript = `
TARGET_DIR="/usr/share/cockpit/btrfs-manager"
if [ ! -d "$TARGET_DIR" ]; then
  for d in /home/*/.local/share/cockpit/btrfs-manager; do
    [ -d "$d" ] && { TARGET_DIR="$d"; break; }
  done
fi

if [ -d "$TARGET_DIR/.git" ]; then
  cd "$TARGET_DIR"
  git config --global --add safe.directory "$TARGET_DIR" 2>/dev/null || true
  git fetch origin main 2>&1
  git reset --hard origin/main 2>&1
else
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT
  git clone --depth 1 https://github.com/NGxID18/btrfs-manager "$TMP_DIR" 2>&1
  cp -rf "$TMP_DIR"/. "$TARGET_DIR"/
fi

chmod -R ugo+rwX "$TARGET_DIR" 2>/dev/null || true
chmod 755 "$TARGET_DIR/install.sh" 2>/dev/null || true
git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || true
echo "SUCCESS"
`;
        cmd(["sh", "-c", updateScript])
          .then(() => {
            customAlert("Update Successful!", "The extension has been updated. The page will reload now...");
            setTimeout(() => window.location.reload(), 1800);
          })
          .catch((err) => customAlert("Update Failed", "Failed to update extension:\n" + err.message));
      },
    );
  });
});

