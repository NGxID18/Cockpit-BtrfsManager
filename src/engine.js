const getDominantProfile = (dfText, type, fallback) => {
  const regex = new RegExp(`${type},\\s*([^:]+):\\s*total=([^,]+),\\s*used=([^\\n]+)`, "gi");
  const matches = [...dfText.matchAll(regex)];
  if (!matches.length) return fallback;

  let dominant = matches[0][1].trim().toUpperCase();
  let maxAllocated = -1;
  for (const match of matches) {
    const tBytes = parseSize(match[2].trim());
    if (tBytes > maxAllocated) {
      maxAllocated = tBytes;
      dominant = match[1].trim().toUpperCase();
    }
  }
  return dominant;
};

window.App = {
  vols: [],
  hw: {},
  mnt: {},
  rootDevs: new Set(),
  hasSnapper: false,
  orphanedSnaps: [],
  activeDetailTab: "subvols",

  async fetch() {
    const masterView = $("view-master");
    const diskContainer = $("disk-container");

    if (masterView && !masterView.classList.contains("hidden-element") && diskContainer) {
      diskContainer.innerHTML = "<p class='loading-text'>Scanning BTRFS &amp; Hardware Topologies...</p>";
    }

    try {
      const [btrfsOut, mntOut, lsblkOut, snapperCheck, rootDeviceOut] = await Promise.all([
        cmd(["btrfs", "filesystem", "show"]),
        cmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"),
        cmd(["lsblk", "-J", "-o", "NAME,PATH,MODEL,VENDOR,TYPE"]).catch(() => "{}"),
        cmd(["sh", "-c", "command -v snapper >/dev/null 2>&1 && echo yes || echo no"]).catch(() => "no"),
        cmd(["findmnt", "-n", "-o", "SOURCE", "-T", "/"]).catch(() => ""),
      ]);

      this.hasSnapper = (snapperCheck || "").trim() === "yes";
      this.mnt = {};
      this.rootDevs = new Set();

      const cleanRootDev = (rootDeviceOut || "").trim().split("[")[0];
      if (cleanRootDev) this.rootDevs.add(cleanRootDev);

      const walkMounts = (nodes) => {
        nodes.forEach((node) => {
          if (node.source && node.target) {
            const baseDev = node.source.split("[")[0];
            if (node.target === "/" || node.target === "/sysroot") {
              this.rootDevs.add(baseDev);
            }
            if (!this.mnt[baseDev] || node.target.length < this.mnt[baseDev].length) {
              this.mnt[baseDev] = node.target;
            }
            this.mnt[node.source] = node.target;
          }
          if (node.children) walkMounts(node.children);
        });
      };
      walkMounts(JSON.parse(mntOut).filesystems || []);

      this.hw = {};
      const walkHw = (nodes, parentModel) => {
        nodes.forEach((node) => {
          const model = [node.vendor, node.model].filter(Boolean).join(" ").trim() || parentModel;
          if (node.path) this.hw[node.path] = model || "Generic Storage";
          if (node.children) walkHw(node.children, model);
        });
      };
      walkHw(JSON.parse(lsblkOut).blockdevices || []);

      await this.parseBtrfs(btrfsOut);
    } catch (err) {
      if (diskContainer) {
        diskContainer.innerHTML = `<p class="text-danger mt-15">Scan Error: ${escapeHtml(err.message)}</p>`;
      }
    }
  },

  async parseBtrfs(output) {
    this.vols = output
      .split(/Label:\s+/i)
      .filter((block) => block.trim() !== "" && /uuid:\s+[a-f0-9-]+/i.test(block))
      .map((block, idx) => {
        const labelMatch = block.match(/^(?:'([^']*)'|(\S+))?\s+uuid:\s+([a-f0-9-]+)/i);
        const uuid = labelMatch ? labelMatch[3] : "Unknown";
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/i);
        const rootPath = pathMatch ? pathMatch[1] : "";
        const blockHasMissing = /\*\*\*\s*Some devices missing/i.test(block);

        const devs = [];
        block.split("\n").forEach((line) => {
          if (/devid/i.test(line) && (/path/i.test(line) || /MISSING/i.test(line))) {
            const idMatch = line.match(/devid\s+(\d+)/i);
            const sizeMatch = line.match(/size\s+([0-9.]+(?:[a-zA-Z]+)?)/i);
            const devPathMatch = line.match(/path\s+(\S+)/i);
            const isMissing = /\bMISSING\b/i.test(line);

            if (idMatch && (devPathMatch || isMissing)) {
              const devPath =
                devPathMatch && devPathMatch[1] !== "MISSING" ? devPathMatch[1] : "MISSING";
              devs.push({
                id: idMatch[1],
                size: sizeMatch ? sizeMatch[1] : "0",
                path: devPath,
                missing: isMissing,
              });
            }
          }
        });

        let mountPoint = (rootPath && this.mnt[rootPath]) || "";
        if (!mountPoint) {
          for (const d of devs) {
            if (this.mnt[d.path]) {
              mountPoint = this.mnt[d.path];
              break;
            }
          }
        }

        const rawSize = formatSize(devs.reduce((sum, d) => sum + parseSize(d.size), 0));
        const hwList =
          [...new Set(devs.map((d) => this.hw[d.path]))].filter(Boolean).join(" & ") ||
          "Standard Storage Device";

        const rawLabel = labelMatch ? (labelMatch[1] ?? labelMatch[2] ?? "") : "";
        const poolLabel =
          rawLabel && rawLabel !== "none" ? rawLabel : `Storage Pool (${uuid.slice(0, 8)})`;

        return {
          idx,
          label: poolLabel,
          uuid,
          mountPoint,
          devs,
          hasMissing: blockHasMissing || devs.some((d) => d.missing),
          rawSize,
          hwList,
          raid: "Loading...",
          usable: "Loading...",
          usedStr: "",
          totalStr: "",
          freeStr: "Loading...",
          usedPct: null,
          snapStatus: "Loading...",
          dataProfile: "SINGLE",
          metaProfile: "DUP",
          mountOptsHtml: "",
          healthHtml: "",
          masterHealthHtml: "",
          devErrors: {},
          devSmart: {},
          totalDevErrors: 0,
        };
      });

    this.renderMaster();

    const activeIdx = $("detail-container")?.getAttribute("data-active-index");
    if (activeIdx !== null && activeIdx !== "" && !$("view-detail")?.classList.contains("hidden-element")) {
      const activeVol = this.vols.find((v) => v.idx == activeIdx);
      if (activeVol) {
        this.updateUI(activeVol);
        if (activeVol.mountPoint) this.fetchSubvols(activeVol.mountPoint, activeVol.idx);
      } else {
        window.stopAllMonitors?.();
        $("view-detail").classList.add("hidden-element");
        $("view-master").classList.remove("hidden-element");
        $("detail-container").setAttribute("data-active-index", "");
      }
    }

    await this.fetchDynamicMetrics();
  },

  computePoolHealth(v) {
    const dangerDevs = [];
    const warnDevs = [];
    (v.devs || []).forEach((d) => {
      const sm = v.devSmart?.[d.path];
      if (!sm || !sm.supported) return;
      if (sm.level === "danger") dangerDevs.push({ path: d.path, sm });
      else if (sm.level === "warn") warnDevs.push({ path: d.path, sm });
    });

    if (v.hasMissing) {
      v.masterHealthHtml = '<span class="pool-status text-danger"><span class="status-dot dot-danger"></span>Degraded</span>';
      v.healthHtml = '<span class="status-dot dot-danger"></span><span class="text-danger">Degraded (missing drive)</span>';
    } else if (v.totalDevErrors > 0 && dangerDevs.length > 0) {
      v.masterHealthHtml = '<span class="pool-status text-danger"><span class="status-dot dot-danger"></span>IO Errors</span>';
      v.healthHtml = `<span class="status-dot dot-danger"></span><span class="text-danger">${v.totalDevErrors} IO error(s), SMART critical on ${escapeHtml(dangerDevs.map((d) => d.path).join(", "))}</span>`;
    } else if (v.totalDevErrors > 0) {
      v.masterHealthHtml = '<span class="pool-status text-danger"><span class="status-dot dot-danger"></span>IO Errors</span>';
      v.healthHtml = `<span class="status-dot dot-danger"></span><span class="text-danger">${v.totalDevErrors} disk error(s) detected</span>`;
    } else if (dangerDevs.length > 0) {
      v.masterHealthHtml = '<span class="pool-status text-danger"><span class="status-dot dot-danger"></span>SMART Critical</span>';
      const detail =
        dangerDevs.length === 1
          ? `${dangerDevs[0].sm.summary} on ${dangerDevs[0].path}`
          : `SMART failure across ${dangerDevs.length} drives`;
      v.healthHtml = `<span class="status-dot dot-danger"></span><span class="text-danger">Critical: ${escapeHtml(detail)}</span>`;
    } else if (warnDevs.length > 0) {
      v.masterHealthHtml = '<span class="pool-status text-warning"><span class="status-dot dot-warn"></span>SMART Warning</span>';
      const detail =
        warnDevs.length === 1
          ? `${warnDevs[0].sm.summary} on ${warnDevs[0].path} (SMART)`
          : `SMART bad sectors on ${warnDevs.map((d) => d.path).join(", ")}`;
      v.healthHtml = `<span class="status-dot dot-warn"></span><span class="text-warning">Warning: ${escapeHtml(detail)}</span>`;
    } else {
      v.masterHealthHtml = '<span class="pool-status"><span class="status-dot dot-ok"></span>Healthy</span>';
      v.healthHtml = '<span class="status-dot dot-ok"></span>Healthy (0 disk errors)';
    }
  },

  async checkOrphanedSnapshots() {
    try {
      const script = `
if command -v snapper >/dev/null 2>&1; then
  snapper list-configs 2>/dev/null | awk 'NR>2 {print $1 "|" $3}' | while IFS="|" read -r cfg subvol; do
    [ -z "$cfg" ] || [ "$cfg" = "Config" ] && continue
    is_orphan=0
    if [ -z "$subvol" ] || [ ! -d "$subvol" ]; then
      is_orphan=1
    elif ! btrfs subvolume show "$subvol" >/dev/null 2>&1; then
      tgt=$(findmnt -n -o TARGET -T "$subvol" 2>/dev/null)
      if [ "$tgt" != "$subvol" ] && [ "$subvol" != "/" ]; then
        is_orphan=1
      elif ! findmnt -n -t btrfs -T "$subvol" >/dev/null 2>&1; then
        is_orphan=1
      fi
    fi
    [ "$is_orphan" -eq 1 ] && echo "$cfg|$subvol"
  done
fi
`;
      const out = await cmd(["sh", "-c", script]);
      this.orphanedSnaps = out
        .trim()
        .split("\n")
        .filter((line) => line.trim().includes("|"))
        .map((line) => {
          const [cfg, subvol] = line.split("|");
          return { cfg: cfg.trim(), subvol: (subvol || "").trim() };
        });
    } catch {
      this.orphanedSnaps = [];
    }
    this.renderOrphanBanner();
  },

  renderOrphanBanner() {
    const el = $("orphan-snap-container");
    if (!el) return;

    if (!this.orphanedSnaps?.length) {
      el.classList.add("hidden-element");
      el.innerHTML = "";
      return;
    }

    const count = this.orphanedSnaps.length;
    const itemsHtml = this.orphanedSnaps
      .map(
        (o) =>
          `<li><strong>${escapeHtml(o.cfg)}</strong> (Target: <span class="btrfs-code">${escapeHtml(o.subvol || "Missing")}</span>)</li>`,
      )
      .join("");

    el.innerHTML = `
      <div>
        <div class="orphan-snap-title">
          <span>Stale Backup Schedules Found</span>
          <span class="orphan-badge">${count} Stale ${count === 1 ? "Schedule" : "Schedules"}</span>
        </div>
        <div class="orphan-snap-desc">
          The following automatic backup schedules point to folders or drives that no longer exist. Removing them will prevent backup errors:
        </div>
        <ul class="danger-list orphan-item-list">${itemsHtml}</ul>
      </div>
      <div class="orphan-snap-actions">
        <button class="btn btn-danger btn-sm btn-action" data-action="clean-orphaned-snaps">Remove Stale Schedules</button>
      </div>
    `;
    el.classList.remove("hidden-element");
  },

  async fetchDynamicMetrics() {
    const snapScript = `
MNT="$1"
STATUS="Not Configured"
CFG=""
if command -v snapper >/dev/null 2>&1; then
  CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
fi

CRON=""
for cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  [ -d "$cdir" ] || continue
  for cf in "$cdir"/btrfs_*; do
    [ -f "$cf" ] || continue
    if grep -qxF "# Target: $MNT" "$cf" 2>/dev/null || { [ -n "$CFG" ] && [ "$CFG" != "Config" ] && { [ "$(basename "$cf")" = "btrfs_snap_$CFG" ] || grep -qxF "# Config: $CFG" "$cf" 2>/dev/null; }; }; then
      CRON="$cf"
      break 2
    fi
  done
done

if [ -n "$CRON" ]; then
  FRQ=$(echo "$CRON" | awk -F'/' '{print $3}' | sed 's/cron\\.//' | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
  LIM=$(grep -E "^# Limit:" "$CRON" 2>/dev/null | awk '{print $3}')
  if [ -z "$LIM" ] && [ -n "$CFG" ] && [ "$CFG" != "Config" ] && command -v snapper >/dev/null 2>&1; then
    LIM=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="NUMBER_LIMIT"{print $3}')
  fi
  STATUS="$FRQ (\${LIM:-5} backups kept)"
elif [ -n "$CFG" ] && [ "$CFG" != "Config" ] && command -v snapper >/dev/null 2>&1; then
  IS_ON=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_CREATE"{print $3}')
  if [ "$IS_ON" = "yes" ]; then
    STATUS="Enabled (Active)"
  fi
fi
echo "$STATUS"
`;

    const allDevPaths = [...new Set(this.vols.flatMap((v) => (v.devs || []).map((d) => d.path)))];
    const smartPromise = window.Smart ? window.Smart.probeDevices(allDevPaths) : Promise.resolve({});

    await Promise.all([
      this.checkOrphanedSnapshots(),
      ...this.vols.map(async (v) => {
        if (!v.mountPoint) {
          v.raid = "Mount required";
          v.usable = "Not mounted";
          v.usedStr = "";
          v.totalStr = "";
          v.freeStr = "";
          v.usedPct = null;
          v.snapStatus = "Locked";
          v.devSmart = await smartPromise.catch(() => ({}));
          this.computePoolHealth(v);
          this.updateUI(v);
          return;
        }

        try {
          const [dfOut, hOut, snapOut, optsOut, statsOut, smartMap] = await Promise.all([
            cmd(["btrfs", "filesystem", "df", v.mountPoint]),
            cmd(["df", "-B1", "--output=size,avail", v.mountPoint]),
            cmd(["sh", "-c", snapScript, "--", v.mountPoint]).catch(() => "Not Configured"),
            cmd(["findmnt", "-n", "-o", "OPTIONS", "-T", v.mountPoint]).catch(() => ""),
            cmd(["btrfs", "device", "stats", v.mountPoint]).catch(() => ""),
            smartPromise.catch(() => ({})),
          ]);

          if (optsOut) {
            const rawOpts = optsOut.trim().split(",");
            const highlightedOpts = [];
            ["compress", "space_cache", "discard"].forEach((prefix) => {
              const found = rawOpts.find((o) => o.startsWith(prefix));
              if (found) highlightedOpts.push(found);
            });
            if (rawOpts.includes("ro")) highlightedOpts.push("read-only");
            if (rawOpts.includes("ssd")) highlightedOpts.push("ssd");
            if (rawOpts.includes("autodefrag")) highlightedOpts.push("autodefrag");

            v.mountOptsHtml = highlightedOpts.length
              ? escapeHtml(highlightedOpts.join(", "))
              : '<span class="text-muted">default</span>';
          } else {
            v.mountOptsHtml = '<span class="text-muted">default</span>';
          }

          let totalDevErrors = 0;
          const devErrors = {};
          if (statsOut) {
            statsOut
              .trim()
              .split("\n")
              .forEach((line) => {
                const match = line.match(/\[([^\]]+)\]\.(\w+)\s+(\d+)/);
                if (match) {
                  const devPath = match[1];
                  const count = parseInt(match[3], 10) || 0;
                  devErrors[devPath] = (devErrors[devPath] || 0) + count;
                  totalDevErrors += count;
                }
              });
          }
          v.devErrors = devErrors;
          v.totalDevErrors = totalDevErrors;
          v.devSmart = smartMap || {};
          this.computePoolHealth(v);

          const dataProfile = getDominantProfile(dfOut, "Data", "SINGLE");
          const metaProfile = getDominantProfile(dfOut, "Metadata", "DUP");
          v.dataProfile = dataProfile;
          v.metaProfile = metaProfile;
          v.raid = `Data: ${escapeHtml(dataProfile)}, Metadata: ${escapeHtml(metaProfile)}`;

          const dfLines = hOut.trim().split("\n");
          if (dfLines.length > 1) {
            const cols = dfLines[1].trim().split(/\s+/);
            const totalBytes = parseInt(cols[0], 10) || 0;
            const availBytes = parseInt(cols[1], 10) || 0;
            const usedBytes = Math.max(0, totalBytes - availBytes);
            v.usedStr = formatSize(usedBytes);
            v.totalStr = formatSize(totalBytes);
            v.freeStr = `${formatSize(availBytes)} available`;
            v.usedPct =
              totalBytes > 0
                ? usedBytes > 0
                  ? Math.max(1.5, Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10))
                  : 0
                : 0;
            v.usable = `${v.usedStr} / ${v.totalStr}`;
          } else {
            v.usable = "Unknown";
            v.usedStr = "";
            v.totalStr = "";
            v.freeStr = "";
            v.usedPct = null;
          }

          v.snapStatus = snapOut.trim() || "Not Configured";
        } catch {
          v.raid = "Error reading profile";
          v.usable = "Error";
          v.usedStr = "";
          v.totalStr = "";
          v.freeStr = "";
          v.usedPct = null;
          v.snapStatus = "Error";
          v.devSmart = await smartPromise.catch(() => ({}));
          this.computePoolHealth(v);
        }

        this.updateUI(v);
      }),
    ]);
  },

  renderProgress(v) {
    if (!v.mountPoint) return '<span class="text-muted">Not mounted</span>';
    if (v.usedPct === null || v.usedPct === undefined) {
      return `<span class="text-muted">${escapeHtml(v.usable || "Loading...")}</span>`;
    }
    const dangerClass = v.usedPct >= 90 ? " usage-bar-danger" : "";
    const pct = Math.max(0, Math.min(100, Number(v.usedPct) || 0));
    const pctLabel = Math.round(pct);
    return `<span class="usage-text">${escapeHtml(v.usedStr)} / ${escapeHtml(v.totalStr)}</span><span class="usage-bar${dangerClass}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pctLabel}" title="${pctLabel}% used (${escapeHtml(v.freeStr)})"><svg class="usage-bar-svg" aria-hidden="true"><rect class="usage-bar-track" width="100%" height="100%"></rect><rect class="usage-bar-indicator" width="${pct}%" height="100%"></rect></svg></span>`;
  },

  renderDevRows(v) {
    return v.devs
      .map((d) => {
        const errCount = (v.devErrors && v.devErrors[d.path]) || 0;
        const sm = v.devSmart && v.devSmart[d.path];
        let statusCell = '<span class="status-dot dot-ok"></span>Healthy';
        if (d.missing) {
          statusCell = '<span class="status-dot dot-danger"></span><span class="text-danger">Missing</span>';
        } else if (errCount > 0 && sm && sm.supported && sm.level !== "ok") {
          statusCell = `<span class="status-dot dot-danger"></span><span class="text-danger">${errCount} IO errors, ${escapeHtml(sm.summary)}</span>`;
        } else if (errCount > 0) {
          statusCell = `<span class="status-dot dot-danger"></span><span class="text-danger">${errCount} IO errors</span>`;
        } else if (sm && sm.supported && sm.level === "danger") {
          statusCell = `<span class="status-dot dot-danger"></span><span class="text-danger">${escapeHtml(sm.summary)}</span>`;
        } else if (sm && sm.supported && sm.level === "warn") {
          statusCell = `<span class="status-dot dot-warn"></span><span class="text-warning">Warning (${escapeHtml(sm.summary)})</span>`;
        }
        const canRemove = v.devs && v.devs.length > 1;

        const removeBtn =
          v.mountPoint && canRemove
            ? d.missing
              ? `<button class="btn-tool btn-tool-danger btn-action" data-action="remove-missing-dev" data-mount="${escapeHtml(v.mountPoint)}">Remove missing</button>`
              : `<button class="btn-tool btn-tool-danger btn-action" data-action="remove-dev" data-mount="${escapeHtml(v.mountPoint)}" data-devpath="${escapeHtml(d.path)}">Remove</button>`
            : "";

        return `<tr>
          <td class="text-mono ${d.missing ? "text-danger" : ""}">${escapeHtml(d.path)}</td>
          <td class="text-muted">${escapeHtml(d.id)}</td>
          <td>${statusCell}</td>
          <td class="text-right">${escapeHtml(d.size)}</td>
          <td class="text-right">${removeBtn}</td>
        </tr>`;
      })
      .join("");
  },

  updateUI(v) {
    if ($(`master-usable-${v.idx}`)) {
      $(`master-usable-${v.idx}`).innerHTML = this.renderProgress(v);
      if ($(`master-snap-${v.idx}`)) $(`master-snap-${v.idx}`).textContent = v.snapStatus;
      if ($(`master-raid-${v.idx}`)) $(`master-raid-${v.idx}`).innerHTML = v.raid;
      if ($(`master-health-${v.idx}`) && v.masterHealthHtml) $(`master-health-${v.idx}`).innerHTML = v.masterHealthHtml;
    }
    if ($(`usable-display-${v.idx}`)) {
      $(`usable-display-${v.idx}`).innerHTML = this.renderProgress(v);
      if ($(`data-prof-display-${v.idx}`)) $(`data-prof-display-${v.idx}`).textContent = v.dataProfile;
      if ($(`meta-prof-display-${v.idx}`)) $(`meta-prof-display-${v.idx}`).textContent = v.metaProfile;
      if ($(`snap-display-${v.idx}`)) $(`snap-display-${v.idx}`).textContent = v.snapStatus;
      if ($(`health-display-${v.idx}`)) $(`health-display-${v.idx}`).innerHTML = v.healthHtml;
      if ($(`opts-display-${v.idx}`)) $(`opts-display-${v.idx}`).innerHTML = v.mountOptsHtml;
      if ($(`raw-cap-display-${v.idx}`)) {
        $(`raw-cap-display-${v.idx}`).textContent = `${v.rawSize} across ${v.devs.length} ${v.devs.length === 1 ? "drive" : "drives"}`;
      }
      if ($(`tab-count-drives-${v.idx}`)) $(`tab-count-drives-${v.idx}`).textContent = String(v.devs.length);
      if ($(`member-drives-tbody-${v.idx}`)) $(`member-drives-tbody-${v.idx}`).innerHTML = this.renderDevRows(v);
    }
  },

  renderMaster() {
    this.renderOrphanBanner();
    const container = $("disk-container");
    if (!container) return;

    if (!this.vols.length) {
      container.innerHTML = "<div class='btrfs-card'><p class='text-muted mb-0'>No active BTRFS storage pools detected.</p></div>";
      return;
    }

    container.innerHTML = `<div class="pool-master-grid">${this.vols
      .map((v) => {
        if (!v.masterHealthHtml) this.computePoolHealth(v);

        return `
        <div class="btrfs-card pool-master-card">
          <div class="card-header-clean">
            <div>
              <button class="pool-title-link btn-action" data-action="open-detail" data-index="${v.idx}">${escapeHtml(v.label)}</button>
              <div class="text-muted text-sm">${escapeHtml(v.hwList)}</div>
            </div>
            <div class="toolbar-actions">
              <span id="master-health-${v.idx}">${v.masterHealthHtml}</span>
              <button class="btn btn-secondary btn-sm btn-action" data-action="open-detail" data-index="${v.idx}">Manage</button>
            </div>
          </div>
          <div class="pool-meta-strip">
            <div>
              <div class="pool-meta-label">Mount point</div>
              <div class="pool-meta-val">${v.mountPoint ? escapeHtml(v.mountPoint) : '<span class="text-muted">Not mounted</span>'}</div>
            </div>
            <div>
              <div class="pool-meta-label">Profiles</div>
              <div class="pool-meta-val" id="master-raid-${v.idx}">${v.raid}</div>
            </div>
            <div>
              <div class="pool-meta-label">Auto-backup</div>
              <div class="pool-meta-val"><span id="master-snap-${v.idx}">${escapeHtml(v.snapStatus)}</span></div>
            </div>
            <div>
              <div class="pool-meta-label">Usage</div>
              <div id="master-usable-${v.idx}" class="pool-meta-val">${this.renderProgress(v)}</div>
            </div>
          </div>
        </div>`;
      })
      .join("")}</div>`;
  },

  renderDetail(idx) {
    const container = $("detail-container");
    if (!container) return;

    const v = this.vols.find((vol) => vol.idx == idx);
    if (!v) return;

    container.setAttribute("data-active-index", idx);
    if ($("detail-breadcrumb-current")) {
      $("detail-breadcrumb-current").textContent = `${v.label} (${v.hwList})`;
    }

    const activeTab = this.activeDetailTab || "subvols";
    const devRows = this.renderDevRows(v);
    const isRoot = v.mountPoint === "/" || v.devs.some((d) => this.rootDevs.has(d.path));
    const bSafe = boxId(v.mountPoint);

    const overviewHeaderAction = !isRoot
      ? `<button class="btn btn-danger btn-sm btn-action" data-action="destroy-vol-modal" data-mount="${escapeHtml(v.mountPoint || "")}" data-uuid="${escapeHtml(v.uuid)}" data-label="${escapeHtml(v.label)}" data-devs="${escapeHtml(v.devs.map((d) => d.path).join(" "))}" data-index="${v.idx}">Delete pool</button>`
      : '<span class="text-muted text-sm">System root pool</span>';

    container.innerHTML = `
      <div class="ct-cards-grid">
        <div class="btrfs-card ct-card-info">
          <div class="card-header-clean mb-15">
            <h3 class="card-title-text">${escapeHtml(v.label)}</h3>
            <div>${overviewHeaderAction}</div>
          </div>
          <div class="spec-table">
            <div class="spec-row"><span class="spec-label">Hardware</span><span class="spec-val">${escapeHtml(v.hwList)}</span></div>
            <div class="spec-row"><span class="spec-label">Mount point</span><span class="spec-val">${v.mountPoint ? escapeHtml(v.mountPoint) : '<span class="text-muted">Not mounted</span>'}</span></div>
            <div class="spec-row">
              <span class="spec-label">Data profile</span>
              <span class="spec-val">
                <span id="data-prof-display-${v.idx}">${escapeHtml(v.dataProfile)}</span>
                ${v.mountPoint ? `<button class="ct-inline-action btn-action" data-action="convert-data" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Change</button>` : ""}
              </span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Metadata profile</span>
              <span class="spec-val">
                <span id="meta-prof-display-${v.idx}">${escapeHtml(v.metaProfile)}</span>
                ${v.mountPoint ? `<button class="ct-inline-action btn-action" data-action="convert-metadata" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Change</button>` : ""}
              </span>
            </div>
            <div class="spec-row"><span class="spec-label">Mount options</span><span id="opts-display-${v.idx}" class="spec-val">${v.mountOptsHtml || '<span class="text-muted">default</span>'}</span></div>
            <div class="spec-row"><span class="spec-label">UUID</span><span class="spec-val text-muted text-mono">${escapeHtml(v.uuid)}</span></div>
          </div>
        </div>

        <div class="btrfs-card ct-card-info">
          <div class="card-header-clean mb-15">
            <h3 class="card-title-text">Usage &amp; health</h3>
          </div>
          <div class="spec-table">
            <div class="spec-row">
              <span class="spec-label">Usage</span>
              <span id="usable-display-${v.idx}" class="spec-val">${this.renderProgress(v)}</span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Health status</span>
              <span class="spec-val">
                <span id="health-display-${v.idx}">${v.healthHtml || '<span class="status-dot dot-ok"></span>Healthy (0 disk errors)'}</span>
                ${v.mountPoint ? `<button class="ct-inline-action btn-action" data-action="device-stats" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Diagnostics</button>` : ""}
              </span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Automatic backups</span>
              <span class="spec-val">
                <span id="snap-display-${v.idx}">${escapeHtml(v.snapStatus)}</span>
                ${v.mountPoint ? `<button class="ct-inline-action btn-action" data-action="subvol-ops" data-op="auto-snap" data-mount="${escapeHtml(v.mountPoint)}">Configure</button>` : ""}
              </span>
            </div>
            <div class="spec-row"><span class="spec-label">Raw capacity</span><span id="raw-cap-display-${v.idx}" class="spec-val">${escapeHtml(v.rawSize)} across ${v.devs.length} ${v.devs.length === 1 ? "drive" : "drives"}</span></div>
          </div>
          ${
            v.mountPoint
              ? `<div class="card-sub-section">
                  <div class="toolbar-actions">
                    <button class="btn btn-secondary btn-sm btn-action" id="btn-scrub-${bSafe}" data-action="scrub" data-mount="${escapeHtml(v.mountPoint)}">Verify &amp; repair</button>
                    <button class="btn btn-secondary btn-sm btn-action" id="btn-balance-${bSafe}" data-action="balance" data-mount="${escapeHtml(v.mountPoint)}">Optimize space</button>
                    <button class="btn btn-secondary btn-sm btn-action" id="btn-defrag-${bSafe}" data-action="defrag" data-mount="${escapeHtml(v.mountPoint)}">Defragment</button>
                  </div>
                  <div id="term-win-${bSafe}" class="terminal-window hidden-element">
                    <div class="terminal-header">
                      <div class="terminal-title">Activity log (${escapeHtml(v.mountPoint)})</div>
                      <div class="terminal-header-actions">
                        <span id="term-status-${bSafe}" class="term-status-badge">Idle</span>
                        <button class="term-clear-btn btn-action" data-action="clear-terminal" data-box="${bSafe}">Clear</button>
                      </div>
                    </div>
                    <div id="maint-console-${bSafe}" class="terminal-body"><span class="term-muted">Ready.</span></div>
                  </div>
                </div>`
              : `<div class="card-sub-section"><p class="text-warning mb-0">Mount this storage pool via Cockpit <b>Storage</b> to unlock subvolume and maintenance tasks.</p></div>`
          }
        </div>

        <div class="btrfs-card workspace-card">
          <div class="workspace-header">
            <div class="pf-tabs" role="tablist">
              <button class="pf-tab-btn btn-action ${activeTab === "subvols" ? "active" : ""}" data-action="switch-tab" data-tab="subvols" data-index="${v.idx}" role="tab">
                Subvolumes <span id="tab-count-subvols-${v.idx}" class="tab-count">...</span>
              </button>
              <button class="pf-tab-btn btn-action ${activeTab === "snaps" ? "active" : ""}" data-action="switch-tab" data-tab="snaps" data-index="${v.idx}" role="tab">
                Snapshots <span id="tab-count-snaps-${v.idx}" class="tab-count">...</span>
              </button>
              <button class="pf-tab-btn btn-action ${activeTab === "drives" ? "active" : ""}" data-action="switch-tab" data-tab="drives" data-index="${v.idx}" role="tab">
                Member drives <span id="tab-count-drives-${v.idx}" class="tab-count">${v.devs.length}</span>
              </button>
            </div>
            ${
              v.mountPoint
                ? `<div class="workspace-actions">
                    <div id="tab-actions-subvols-${v.idx}" class="toolbar-actions ${activeTab === "subvols" ? "" : "hidden-element"}">
                      <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="create" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Create subvolume</button>
                    </div>
                    <div id="tab-actions-snaps-${v.idx}" class="toolbar-actions ${activeTab === "snaps" ? "" : "hidden-element"}">
                      <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="snap-root" data-mount="${escapeHtml(v.mountPoint)}">Take snapshot</button>
                      <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="auto-snap" data-mount="${escapeHtml(v.mountPoint)}">Automatic backups</button>
                      <button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="purge-snaps" data-mount="${escapeHtml(v.mountPoint)}">Clean old</button>
                    </div>
                    <div id="tab-actions-drives-${v.idx}" class="toolbar-actions ${activeTab === "drives" ? "" : "hidden-element"}">
                      <button class="btn btn-secondary btn-sm btn-action" data-action="add-dev-modal" data-mount="${escapeHtml(v.mountPoint)}">Add drive</button>
                    </div>
                  </div>`
                : ""
            }
          </div>

          <div id="tab-panel-subvols-${v.idx}" class="${activeTab === "subvols" ? "" : "hidden-element"}">
            ${
              v.mountPoint
                ? `<div id="subvol-list-${v.idx}" class="table-scroll-container"><p class="p-15-muted">Loading subvolumes...</p></div>`
                : '<p class="p-15-muted">Mount storage pool in Cockpit Storage to view and manage subvolumes.</p>'
            }
          </div>

          <div id="tab-panel-snaps-${v.idx}" class="${activeTab === "snaps" ? "" : "hidden-element"}">
            ${
              v.mountPoint
                ? `<div id="snapshot-list-${v.idx}" class="table-scroll-container"><p class="p-15-muted">Loading snapshots...</p></div>`
                : '<p class="p-15-muted">Mount storage pool in Cockpit Storage to view and manage snapshots.</p>'
            }
          </div>

          <div id="tab-panel-drives-${v.idx}" class="${activeTab === "drives" ? "" : "hidden-element"}">
            <div class="table-scroll-container">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>DevID</th>
                    <th>Status</th>
                    <th class="text-right">Capacity</th>
                    <th class="text-right"></th>
                  </tr>
                </thead>
                <tbody id="member-drives-tbody-${v.idx}">${devRows}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;

    if (v.mountPoint) this.fetchSubvols(v.mountPoint, v.idx);
  },

  async fetchSubvols(mount, idx) {
    if (!$(`subvol-list-${idx}`) && !$(`snapshot-list-${idx}`)) return;

    try {
      const script = `
MNT="$1"
${Sh.mountTopLevel}

SCAN_DIR="$MNT"
[ "$IS_MOUNTED" -eq 1 ] && SCAN_DIR="$TMP"

SNAP_RAW=$(btrfs subvolume list -s "$SCAN_DIR" 2>/dev/null)
SNAP_IDS=$(echo "$SNAP_RAW" | awk '{print $2}')
SNAP_TIMES=$(echo "$SNAP_RAW" | awk '{
  id=$2; ot="";
  for(i=1;i<=NF;i++) if($i=="otime"){ot=$(i+1)" "$(i+2); break}
  if(id && ot) print id"|"ot
}')
RO_IDS=$(btrfs subvolume list -r "$SCAN_DIR" 2>/dev/null | awk '{print $2}')
DEFAULT_ID=$(btrfs subvolume get-default "$SCAN_DIR" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="ID") print $(i+1)}' | head -n 1)
ACTIVE_MOUNTS=$(findmnt -n -l -o TARGET,SOURCE -t btrfs 2>/dev/null | grep -v "^/tmp")

FSTAB_SUBVOLS=$(awk '!/^[[:space:]]*#/ && NF>=4 {
  n=split($4, o, ",");
  for(i=1;i<=n;i++) {
    if (o[i] ~ /^subvol=/) {
      v = o[i];
      sub(/^subvol=\\/*/, "", v);
      print v;
      if (v ~ /^@/) { sub(/^@/, "", v); print v; }
    }
  }
}' /etc/fstab 2>/dev/null)

btrfs subvolume list "$SCAN_DIR" 2>/dev/null | while read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | awk '{print $2}')
  sub_path=$(echo "$line" | sed -n 's/.*path \\(.*\\)/\\1/p')
  [ -z "$id" ] && continue

  IS_SNAP="false"
  case "$sub_path" in
    .snapshots|@snapshots|*/.snapshots|*/@snapshots) IS_SNAP="false" ;;
    *)
      if echo " $SNAP_IDS " | grep -q " $id "; then
        IS_SNAP="true"
      elif echo "$sub_path" | grep -q -E "\\.snapshots/|/snapshot|_snap_|snap-"; then
        IS_SNAP="true"
      fi
      ;;
  esac

  IS_RO="false"
  echo " $RO_IDS " | grep -q " $id " && IS_RO="true"

  IS_DEF="false"
  [ -n "$DEFAULT_ID" ] && [ "$id" = "$DEFAULT_ID" ] && IS_DEF="true"

  resolve_subvol_path "$sub_path" || true

  ctime=""
  if [ -n "$SNAP_TIMES" ]; then
    ctime=$(echo "$SNAP_TIMES" | awk -F'|' -v id="$id" '$1 == id {print $2; exit}')
  fi
  if [ -z "$ctime" ] && [ -n "$TARGET_PATH" ]; then
    ctime=$(stat -c '%w' "$TARGET_PATH" 2>/dev/null | awk '$1 != "-" && $1 != "" {print $1, substr($2, 1, 8)}')
  fi
  if [ -z "$ctime" ]; then
    ctime=$(btrfs subvolume show -r "$id" "$SCAN_DIR" 2>/dev/null | awk '/Creation time:/ {print $3, $4; exit}')
  fi
  if [ -z "$ctime" ] && [ -n "$TARGET_PATH" ]; then
    ctime=$(btrfs subvolume show "$TARGET_PATH" 2>/dev/null | awk '/Creation time:/ {print $3, $4; exit}')
  fi
  [ -z "$ctime" ] || [ "$ctime" = "-" ] && ctime="Active Subvolume"

  nocow="false"
  MOUNT_PT=""
  IN_FSTAB="false"

  if [ "$IS_SNAP" = "false" ]; then
    MOUNT_PT=$(echo "$ACTIVE_MOUNTS" | awk -v sp="$sub_path" '{
      s = $2;
      if (sub(/^.*\\[\\/*/, "", s) && sub(/\\].*$/, "", s) && s == sp) { print $1; exit }
    }')
    [ -z "$TARGET_PATH" ] && [ -n "$MOUNT_PT" ] && TARGET_PATH="$MOUNT_PT"

    if [ -n "$TARGET_PATH" ]; then
      attr=$(lsattr -d "$TARGET_PATH" 2>/dev/null | awk '{print $1}')
      case "$attr" in *C*) nocow="true" ;; esac
    fi

    if [ -n "$FSTAB_SUBVOLS" ] && echo "$FSTAB_SUBVOLS" | grep -qxF "$sub_path"; then
      IN_FSTAB="true"
    fi
  fi

  echo "$id|$sub_path|$nocow|$ctime|$MOUNT_PT|$IN_FSTAB|$IS_SNAP|$IS_RO|$IS_DEF"
done
`;

      const out = await cmd(["sh", "-c", script, "--", mount]);
      let subvolsRows = "";
      let snapshotsRows = "";
      let subvolCount = 0;
      let snapCount = 0;

      out
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .forEach((line) => {
          const parts = line.split("|");
          if (parts.length < 4) return;
          const [id, path, nocowStr, ctime, mountPt = "", inFstabStr, isSnapStr, isRoStr, isDefStr] = parts;

          const nocow = nocowStr === "true";
          const inFstab = inFstabStr === "true";
          const isRo = isRoStr === "true";
          const isDef = isDefStr === "true";

          const isSnapshotContainer =
            path === ".snapshots" ||
            path === "@snapshots" ||
            path.endsWith("/.snapshots") ||
            path.endsWith("/@snapshots");

          const isSnapshot = !isSnapshotContainer && isSnapStr === "true";
          const isRootSubvol =
            mountPt === "/" ||
            (mount === "/" && (path === "@" || path === "" || path === "root" || path === "rootfs" || path === "@root"));

          const isProtected = isSnapshotContainer || isRootSubvol || Boolean(mountPt) || inFstab;

          if (isSnapshot) {
            snapCount++;
            const accessText = isRo ? "Read-only" : '<span class="text-warning">Writable</span>';
            snapshotsRows += `<tr>
              <td class="fw-medium">/${escapeHtml(path)}</td>
              <td>${accessText}</td>
              <td class="text-muted">${escapeHtml(ctime)}</td>
              <td class="text-muted">${escapeHtml(id)}</td>
              <td class="text-right">
                <div class="btn-group-sharp">
                  <button class="btn-tool btn-action" title="Restore this snapshot into a new writable folder" data-action="subvol-ops" data-op="clone-snap" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}">Restore</button>
                  <button class="btn-tool btn-action" title="${isRo ? "Make writable" : "Protect as Read-Only"}" data-action="subvol-ops" data-op="toggle-ro" data-ro="${isRo ? "false" : "true"}" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-index="${idx}">
                    ${isRo ? "Unlock" : "Lock"}
                  </button>
                  <button class="btn-tool btn-tool-danger btn-action" title="Delete snapshot" data-action="subvol-ops" data-op="del" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}">Delete</button>
                </div>
              </td>
            </tr>`;
          } else {
            subvolCount++;
            const modeParts = [];
            if (isSnapshotContainer) modeParts.push("Snapshot storage");
            else if (nocow) modeParts.push('<span class="text-warning" title="Copy-on-Write disabled">NoCoW (Direct)</span>');
            else modeParts.push("Copy-on-Write");
            if (isRo) modeParts.push('<span class="text-muted">read-only</span>');
            if (isDef) modeParts.push('<span class="text-primary">default</span>');

            const locationHtml = isRootSubvol
              ? "/ (OS Root)"
              : mountPt
                ? escapeHtml(mountPt)
                : inFstab
                  ? '<span class="text-muted">in /etc/fstab</span>'
                  : '<span class="text-muted">—</span>';

            const segments = path.split("/").filter(Boolean);
            const depth = Math.max(0, segments.length - 1);
            const shortName = segments.length ? segments[segments.length - 1] : "/";
            const depthClasses = ["", "subvol-depth-1", "subvol-depth-2", "subvol-depth-3", "subvol-depth-4"];
            const depthClass = depth > 0 ? ` class="${depthClasses[Math.min(depth, 4)]}"` : "";

            const actionButtons = isSnapshotContainer
              ? '<span class="text-muted text-sm">Protected</span>'
              : `<div class="btn-group-sharp">
                  <button class="btn-tool btn-action" title="${nocow ? "Enable Copy-on-Write (+CoW)" : "Disable Copy-on-Write (NoCoW)"}" data-action="subvol-ops" data-op="${nocow ? "enable-cow" : "disable-cow"}" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-index="${idx}">
                    ${nocow ? "Enable CoW" : "Disable CoW"}
                  </button>
                  ${
                    !isProtected
                      ? `<button class="btn-tool btn-tool-danger btn-action" title="Delete subvolume" data-action="subvol-ops" data-op="del" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}" data-mounted-at="${escapeHtml(mountPt)}" data-is-protected="${isProtected}">Delete</button>`
                      : ""
                  }
                </div>`;

            subvolsRows += `<tr>
              <td${depthClass}><span class="fw-medium">${escapeHtml(shortName)}</span></td>
              <td class="text-muted text-mono">/${escapeHtml(path)}</td>
              <td>${locationHtml}</td>
              <td>${modeParts.join(", ")}</td>
              <td class="text-muted">${escapeHtml(ctime)}</td>
              <td class="text-right">${actionButtons}</td>
            </tr>`;
          }
        });

      if ($(`tab-count-subvols-${idx}`)) $(`tab-count-subvols-${idx}`).textContent = String(subvolCount);
      if ($(`tab-count-snaps-${idx}`)) $(`tab-count-snaps-${idx}`).textContent = String(snapCount);

      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML = subvolsRows
          ? `<table class="data-table">
              <thead>
                <tr>
                  <th>Subvolume</th>
                  <th>Path</th>
                  <th>Mount point</th>
                  <th>Write mode</th>
                  <th>Created</th>
                  <th class="text-right"></th>
                </tr>
              </thead>
              <tbody>${subvolsRows}</tbody>
            </table>`
          : "<p class='p-15-muted'>No active user subvolumes found inside this pool root.</p>";
      }

      if ($(`snapshot-list-${idx}`)) {
        $(`snapshot-list-${idx}`).innerHTML = snapshotsRows
          ? `<table class="data-table">
              <thead>
                <tr>
                  <th>Snapshot</th>
                  <th>Access</th>
                  <th>Created</th>
                  <th>ID</th>
                  <th class="text-right"></th>
                </tr>
              </thead>
              <tbody>${snapshotsRows}</tbody>
            </table>`
          : "<p class='p-15-muted'>No snapshots created yet for this volume.</p>";
      }
    } catch (err) {
      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML = `<p class='text-danger mt-15'>Load failed: ${escapeHtml(err.message)}</p>`;
      }
    }
  },
};
