window.$ = (id) => document.getElementById(id);
window.on = (id, evt, cb) => $(id)?.addEventListener(evt, cb);

window.boxId = (mnt) => (!mnt || mnt === "/" ? "root" : mnt.replace(/[^a-zA-Z0-9]/g, "-"));

window.cmd = (args, opts = {}) =>
  cockpit.spawn(args, {
    superuser: "require",
    environ: ["LC_ALL=C.UTF-8", "LANG=C.UTF-8"],
    ...opts,
  });

window.escapeHtml = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

window.parseSize = (val) => {
  if (!val) return 0;
  const match = String(val).match(/([0-9.]+)\s*([KMGTPE]?)/i);
  if (!match) return 0;
  const unitExponents = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  const exp = unitExponents[match[2].toUpperCase()] || 0;
  return parseFloat(match[1]) * Math.pow(1024, exp);
};

window.formatSize = (bytes) => {
  if (!bytes || isNaN(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return i <= 0 ? `${Math.round(bytes)} B` : `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
};

window.Sh = {
  mountTopLevel: `
DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
[ -z "$DEV" ] && DEV=$(df -P "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
case "$DEV" in
  UUID=*|LABEL=*) DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1) ;;
esac

TMP=$(mktemp -d)
IS_MOUNTED=0

cleanup_tmp() {
  if [ "\${IS_MOUNTED:-0}" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
  fi
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup_tmp EXIT

if [ -n "$DEV" ]; then
  if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null || \\
     mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null || \\
     mount -t btrfs -o subvolid=5,ro "$DEV" "$TMP" 2>/dev/null; then
    IS_MOUNTED=1
  fi
fi

resolve_subvol_path() {
  _sp="$1"
  TARGET_PATH=""
  if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$_sp" ]; then
    TARGET_PATH="$TMP/$_sp"
  elif [ -e "$MNT/$_sp" ]; then
    TARGET_PATH="$MNT/$_sp"
  elif [ "$MNT" = "/" ] && [ -e "/$_sp" ]; then
    TARGET_PATH="/$_sp"
  fi
  [ -n "$TARGET_PATH" ]
}

in_fstab() {
  awk -v sp="$1" '!/^[[:space:]]*#/ && NF>=4 {
    n=split($4, o, ",");
    for(i=1;i<=n;i++) if(o[i]=="subvol="sp || o[i]=="subvol=/"sp || o[i]=="subvol=@"sp || o[i]=="subvol=/@"sp) {f=1; exit}
  } END {exit !f}' /etc/fstab 2>/dev/null
}
`,

  cleanSnapperFn: `
clean_target_cron() {
  _tgt="$1"
  _cfg="$2"
  for _cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
    [ -d "$_cdir" ] || continue
    for _cf in "$_cdir"/btrfs_*; do
      [ -f "$_cf" ] || continue
      if { [ -n "$_tgt" ] && grep -qxF "# Target: $_tgt" "$_cf" 2>/dev/null; } || \\
         { [ -n "$_cfg" ] && [ "$_cfg" != "Config" ] && [ "$_cfg" != "root" ] && { [ "$(basename "$_cf")" = "btrfs_snap_$_cfg" ] || grep -qxF "# Config: $_cfg" "$_cf" 2>/dev/null; }; }; then
        rm -f "$_cf" 2>/dev/null || true
      fi
    done
  done
}

purge_snapper_cfg() {
  _cfg="$1"
  [ -z "$_cfg" ] || [ "$_cfg" = "Config" ] || [ "$_cfg" = "root" ] && return 0
  if command -v snapper >/dev/null 2>&1; then
    snapper -c "$_cfg" delete-config 2>/dev/null || true
  fi
  rm -f "/etc/snapper/configs/$_cfg" 2>/dev/null || true
  clean_target_cron "" "$_cfg"
  for _f in /etc/conf.d/snapper /etc/default/snapper /etc/sysconfig/snapper; do
    if [ -f "$_f" ]; then
      sed -i -E "/^SNAPPER_CONFIGS=/ { s/\\b$_cfg\\b//g; s/\"[[:space:]]+/\"/; s/[[:space:]]+\"/\"/; s/[[:space:]]+/ /g; }" "$_f" 2>/dev/null || true
    fi
  done
}
`,

  smartProbePy: `
import os, re, sys, json, fcntl, ctypes, struct, concurrent.futures

SG_IO = 0x2285
NVME_IOCTL_ADMIN_CMD = 0xC0484E41

class SgIoHdr(ctypes.Structure):
  _fields_ = [
    ('interface_id', ctypes.c_int), ('dxfer_direction', ctypes.c_int),
    ('cmd_len', ctypes.c_ubyte), ('mx_sb_len', ctypes.c_ubyte),
    ('iovec_count', ctypes.c_ushort), ('dxfer_len', ctypes.c_uint),
    ('dxferp', ctypes.c_void_p), ('cmdp', ctypes.c_void_p), ('sbp', ctypes.c_void_p),
    ('timeout', ctypes.c_uint), ('flags', ctypes.c_uint), ('pack_id', ctypes.c_int),
    ('usr_ptr', ctypes.c_void_p), ('status', ctypes.c_ubyte),
    ('masked_status', ctypes.c_ubyte), ('msg_status', ctypes.c_ubyte),
    ('sb_len_wr', ctypes.c_ubyte), ('host_status', ctypes.c_ushort),
    ('driver_status', ctypes.c_ushort), ('resid', ctypes.c_int),
    ('duration', ctypes.c_uint), ('info', ctypes.c_uint),
  ]

class NvmeAdminCmd(ctypes.Structure):
  _fields_ = [
    ('opcode', ctypes.c_uint8), ('flags', ctypes.c_uint8), ('rsvd1', ctypes.c_uint16),
    ('nsid', ctypes.c_uint32), ('cdw2', ctypes.c_uint32), ('cdw3', ctypes.c_uint32),
    ('metadata', ctypes.c_uint64), ('addr', ctypes.c_uint64),
    ('metadata_len', ctypes.c_uint32), ('data_len', ctypes.c_uint32),
    ('cdw10', ctypes.c_uint32), ('cdw11', ctypes.c_uint32), ('cdw12', ctypes.c_uint32),
    ('cdw13', ctypes.c_uint32), ('cdw14', ctypes.c_uint32), ('cdw15', ctypes.c_uint32),
    ('timeout_ms', ctypes.c_uint32), ('result', ctypes.c_uint32),
  ]

def ata_str(b):
  return bytes(b[i ^ 1] for i in range(len(b))).decode('ascii', 'ignore').strip()

def sg_ata(fd, ata_cmd, feat=0, lba_mid=0, lba_high=0, use_12=False, data_in=True):
  proto = 0x08 if data_in else 0x06
  tflag = 0x0E if data_in else 0x20
  cnt = 1 if data_in else 0
  if use_12:
    cdb = (ctypes.c_ubyte * 12)(0xA1, proto, tflag, feat, cnt, 0, lba_mid, lba_high, 0, ata_cmd, 0, 0)
  else:
    cdb = (ctypes.c_ubyte * 16)(0x85, proto, tflag, 0, feat, 0, cnt, 0, 0, 0, lba_mid, 0, lba_high, 0, ata_cmd, 0)
  sb = (ctypes.c_ubyte * 32)()
  buf = (ctypes.c_ubyte * 512)() if data_in else None
  hdr = SgIoHdr()
  hdr.interface_id = ord('S')
  hdr.dxfer_direction = -3 if data_in else -1
  hdr.cmd_len = len(cdb)
  hdr.mx_sb_len = 32
  hdr.dxfer_len = 512 if data_in else 0
  hdr.dxferp = ctypes.addressof(buf) if data_in else None
  hdr.cmdp = ctypes.addressof(cdb)
  hdr.sbp = ctypes.addressof(sb)
  hdr.timeout = 5000
  try:
    fcntl.ioctl(fd, SG_IO, hdr)
  except Exception:
    return (False, None, b'')
  if hdr.host_status != 0:
    return (False, None, b'')
  sb_len = hdr.sb_len_wr
  sb_bytes = bytes(sb[:sb_len]) if sb_len > 0 else b''
  if sb_len > 0:
    resp = sb[0] & 0x7E
    skey = (sb[1] & 0x0F) if resp == 0x72 else (sb[2] & 0x0F)
    if skey not in (0x00, 0x01):
      return (False, None, sb_bytes)
  if data_in:
    out = bytes(buf)
    if not any(out):
      return (False, None, sb_bytes)
    return (True, out, sb_bytes)
  return (True, None, sb_bytes)

def probe_nvme(disk_path, name):
  m = re.match('^nvme([0-9]+)n[0-9]+$', name)
  ctrl = ('/dev/nvme' + m.group(1)) if m and os.path.exists('/dev/nvme' + m.group(1)) else disk_path
  fd = os.open(ctrl, os.O_RDONLY | os.O_NONBLOCK)
  try:
    id_buf = (ctypes.c_ubyte * 4096)()
    c_id = NvmeAdminCmd(opcode=0x06, nsid=0, addr=ctypes.addressof(id_buf), data_len=4096, cdw10=1, timeout_ms=5000)
    model, serial = '', ''
    try:
      fcntl.ioctl(fd, NVME_IOCTL_ADMIN_CMD, c_id)
      raw_id = bytes(id_buf)
      serial = raw_id[4:24].decode('ascii', 'ignore').strip()
      model = raw_id[24:64].decode('ascii', 'ignore').strip()
    except Exception:
      pass
    log_buf = (ctypes.c_ubyte * 512)()
    c_log = NvmeAdminCmd(opcode=0x02, nsid=0xFFFFFFFF, addr=ctypes.addressof(log_buf), data_len=512, cdw10=0x007F0002, timeout_ms=5000)
    fcntl.ioctl(fd, NVME_IOCTL_ADMIN_CMD, c_log)
    sb = bytes(log_buf)
    crit = sb[0]
    temp_k = struct.unpack_from('<H', sb, 1)[0]
    return {
      'model_name': model,
      'serial_number': serial,
      'device': {'type': 'nvme'},
      'smart_status': {'passed': crit == 0},
      'nvme_smart_health_information_log': {
        'critical_warning': crit,
        'temperature': temp_k,
        'available_spare': sb[3],
        'available_spare_threshold': sb[4],
        'percentage_used': sb[5],
        'power_on_hours': int.from_bytes(sb[128:144], 'little'),
        'media_and_data_integrity_errors': int.from_bytes(sb[160:176], 'little'),
      },
    }
  finally:
    os.close(fd)

def probe_ata(disk_path, is_usb):
  fd = os.open(disk_path, os.O_RDONLY | os.O_NONBLOCK)
  try:
    use_12 = False
    ok, smart_data, _ = sg_ata(fd, 0xB0, 0xD0, 0x4F, 0xC2, use_12=False, data_in=True)
    if not ok:
      use_12 = True
      ok, smart_data, _ = sg_ata(fd, 0xB0, 0xD0, 0x4F, 0xC2, use_12=True, data_in=True)
    if not ok or not smart_data:
      return {}
    model, serial = '', ''
    ok_id, id_buf, _ = sg_ata(fd, 0xEC, 0, 0, 0, use_12=use_12, data_in=True)
    if ok_id and id_buf:
      serial = ata_str(id_buf[20:40])
      model = ata_str(id_buf[54:94])
    thresh_map = {}
    ok_th, th_buf, _ = sg_ata(fd, 0xB0, 0xD1, 0x4F, 0xC2, use_12=use_12, data_in=True)
    if ok_th and th_buf:
      for i in range(30):
        o = 2 + i * 12
        aid = th_buf[o]
        if aid != 0:
          thresh_map[aid] = th_buf[o + 1]
    passed = True
    ok_st, _, sb_bytes = sg_ata(fd, 0xB0, 0xDA, 0x4F, 0xC2, use_12=use_12, data_in=False)
    if ok_st and sb_bytes:
      resp = sb_bytes[0] & 0x7E
      if resp == 0x72 and len(sb_bytes) >= 8:
        off, end = 8, min(len(sb_bytes), 8 + sb_bytes[7])
        while off + 1 < end:
          dtype, dlen = sb_bytes[off], sb_bytes[off + 1]
          if dtype == 0x09 and off + 13 < end and sb_bytes[off + 9] == 0xF4 and sb_bytes[off + 11] == 0x2C:
            passed = False
          off += 2 + dlen if dlen >= 0 else end
      elif resp == 0x70 and len(sb_bytes) > 12 and sb_bytes[12] == 0x5D:
        passed = False
    table = []
    for i in range(30):
      o = 2 + i * 12
      aid = smart_data[o]
      if aid == 0:
        continue
      flags = struct.unpack_from('<H', smart_data, o + 1)[0]
      val, raw6 = smart_data[o + 3], smart_data[o + 5 : o + 11]
      thresh = thresh_map.get(aid, 0)
      failed_now = bool((flags & 1) and thresh > 0 and 0 < val <= thresh)
      if failed_now:
        passed = False
      if aid in (190, 194):
        rval = raw6[0]
      elif aid == 9:
        rval = int.from_bytes(raw6[0:3], 'little')
      else:
        rval = struct.unpack_from('<I', raw6, 0)[0]
      table.append({'id': aid, 'when_failed': 'NOW' if failed_now else '', 'raw': {'value': rval, 'string': str(rval)}})
    proto = ('usb-sat,12' if use_12 else 'usb-sat') if is_usb else ('sat,12' if use_12 else 'ata')
    return {
      'model_name': model,
      'serial_number': serial,
      'device': {'type': proto},
      'smart_status': {'passed': passed},
      'ata_smart_attributes': {'table': table},
    }
  finally:
    os.close(fd)

def probe_one(dev):
  try:
    if not os.path.exists(dev):
      return {}
    real = os.path.realpath(dev)
    name = os.path.basename(real)
    sdir = os.path.realpath('/sys/class/block/' + name)
    if os.path.isfile(os.path.join(sdir, 'partition')):
      sdir = os.path.dirname(sdir)
      name = os.path.basename(sdir)
    disk_path = '/dev/' + name
    if not os.path.exists(disk_path):
      return {}
    if name.startswith('nvme'):
      return probe_nvme(disk_path, name)
    return probe_ata(disk_path, '/usb' in sdir)
  except Exception:
    return {}

devs = sys.argv[1:]
with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, max(1, len(devs)))) as ex:
  res = dict(zip(devs, ex.map(probe_one, devs)))
print(json.dumps(res))
`,
};

window.Smart = {
  parseRawInt(attr) {
    const rawStr = attr?.raw?.string;
    if (typeof rawStr === "string") {
      const m = rawStr.trim().match(/^(\d+)/);
      if (m) return parseInt(m[1], 10) || 0;
    }
    return typeof attr?.raw?.value === "number" ? attr.raw.value : 0;
  },

  parseJson(raw) {
    const empty = {
      supported: false,
      passed: true,
      level: "ok",
      model: "",
      serial: "",
      protocol: "",
      tempC: null,
      powerOnHours: null,
      reallocated: 0,
      runtimeBad: 0,
      endToEnd: 0,
      reportedUncorr: 0,
      pending: 0,
      offlineUncorr: 0,
      crcErrors: 0,
      nvmeCritWarn: 0,
      nvmeMediaErrs: 0,
      nvmePctUsed: 0,
      scsiGrownDefects: 0,
      totalBadSectors: 0,
      summary: "Healthy",
    };
    if (!raw) return empty;

    let data;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        return empty;
      }
    } else if (typeof raw === "object") {
      data = raw;
    } else {
      return empty;
    }
    if (!data || typeof data !== "object") return empty;

    const model = String(data.model_name || data.scsi_model_name || "").trim();
    const serial = String(data.serial_number || "").trim();
    const protocol = String(data.device?.type || data.device?.protocol || "").trim();
    const hasStatus = typeof data.smart_status?.passed === "boolean";
    const passed = data.smart_status?.passed !== false;

    let supported = hasStatus;
    let attrFailedNow = false;
    let hasId5 = false;
    let reallocated = 0;
    let reallocEvents = 0;
    let runtimeBad = 0;
    let endToEnd = 0;
    let reportedUncorr = 0;
    let pending = 0;
    let offlineUncorr = 0;
    let crcErrors = 0;
    let tempC = null;
    let powerOnHours = null;

    const table = data.ata_smart_attributes?.table;
    if (Array.isArray(table)) {
      supported = true;
      for (const attr of table) {
        if (!attr || typeof attr !== "object") continue;
        if (String(attr.when_failed || "").toUpperCase().includes("NOW")) {
          attrFailedNow = true;
        }
        switch (attr.id) {
          case 5:
            reallocated = this.parseRawInt(attr);
            hasId5 = true;
            break;
          case 9:
            if (powerOnHours === null) powerOnHours = this.parseRawInt(attr);
            break;
          case 183:
            runtimeBad = this.parseRawInt(attr);
            break;
          case 184:
            endToEnd = this.parseRawInt(attr);
            break;
          case 187:
            reportedUncorr = this.parseRawInt(attr);
            break;
          case 190:
            if (tempC === null) tempC = this.parseRawInt(attr);
            break;
          case 194:
            tempC = this.parseRawInt(attr);
            break;
          case 196:
            reallocEvents = this.parseRawInt(attr);
            break;
          case 197:
            pending = this.parseRawInt(attr);
            break;
          case 198:
            offlineUncorr = this.parseRawInt(attr);
            break;
          case 199:
            crcErrors = this.parseRawInt(attr);
            break;
        }
      }
    }

    let nvmeCritWarn = 0;
    let nvmeMediaErrs = 0;
    let nvmePctUsed = 0;
    let nvmeSpareLow = false;
    const nvme = data.nvme_smart_health_information_log;
    if (nvme && typeof nvme === "object") {
      supported = true;
      nvmeCritWarn = Number(nvme.critical_warning) || 0;
      nvmeMediaErrs = Number(nvme.media_and_data_integrity_errors) || 0;
      nvmePctUsed = Number(nvme.percentage_used) || 0;
      if (
        typeof nvme.available_spare === "number" &&
        typeof nvme.available_spare_threshold === "number" &&
        nvme.available_spare_threshold > 0 &&
        nvme.available_spare <= nvme.available_spare_threshold
      ) {
        nvmeSpareLow = true;
      }
      if (typeof nvme.temperature === "number" && tempC === null) {
        tempC = nvme.temperature > 200 ? Math.round(nvme.temperature - 273.15) : nvme.temperature;
      }
      if (typeof nvme.power_on_hours === "number" && powerOnHours === null) {
        powerOnHours = nvme.power_on_hours;
      }
    }

    let scsiGrownDefects = 0;
    if (typeof data.scsi_grown_defect_list === "number") {
      supported = true;
      scsiGrownDefects = data.scsi_grown_defect_list;
    }

    if (tempC === null && typeof data.temperature?.current === "number") {
      tempC = data.temperature.current;
    }
    if (powerOnHours === null && typeof data.power_on_time?.hours === "number") {
      powerOnHours = data.power_on_time.hours;
    }

    const remapped = hasId5 ? reallocated : reallocEvents;
    const totalBadSectors = pending + offlineUncorr + remapped + scsiGrownDefects;

    let level = "ok";
    let summary = "Healthy";

    if (
      !passed ||
      attrFailedNow ||
      pending > 0 ||
      offlineUncorr > 0 ||
      reportedUncorr > 0 ||
      nvmeCritWarn > 0 ||
      nvmeMediaErrs > 0 ||
      nvmeSpareLow
    ) {
      level = "danger";
      if (!passed || attrFailedNow) {
        summary = totalBadSectors > 0 ? `SMART FAILED (${totalBadSectors} bad sectors)` : "SMART FAILED";
      } else if (pending + offlineUncorr > 0) {
        summary = `${pending + offlineUncorr} unstable/uncorrectable sectors`;
      } else if (reportedUncorr > 0) {
        summary = `${reportedUncorr} uncorrectable errors`;
      } else if (nvmeMediaErrs > 0) {
        summary = `${nvmeMediaErrs} NVMe media errors`;
      } else {
        summary = "SMART critical warning";
      }
    } else if (
      remapped > 0 ||
      runtimeBad > 0 ||
      endToEnd > 0 ||
      scsiGrownDefects > 0 ||
      nvmePctUsed >= 95
    ) {
      level = "warn";
      if (remapped > 0) {
        summary = `${remapped} bad sectors`;
      } else if (scsiGrownDefects > 0) {
        summary = `${scsiGrownDefects} grown defects`;
      } else if (runtimeBad > 0) {
        summary = `${runtimeBad} bad blocks`;
      } else if (endToEnd > 0) {
        summary = `${endToEnd} parity errors`;
      } else {
        summary = `NVMe wear ${nvmePctUsed}%`;
      }
    }

    return {
      supported,
      passed,
      level,
      model,
      serial,
      protocol,
      tempC,
      powerOnHours,
      reallocated: remapped,
      runtimeBad,
      endToEnd,
      reportedUncorr,
      pending,
      offlineUncorr,
      crcErrors,
      nvmeCritWarn,
      nvmeMediaErrs,
      nvmePctUsed,
      scsiGrownDefects,
      totalBadSectors,
      summary,
    };
  },

  async probeDevices(paths) {
    const unique = [...new Set((paths || []).filter((p) => p && p !== "MISSING" && p.startsWith("/dev/")))];
    if (!unique.length) return {};
    const raw = await cmd(["python3", "-c", Sh.smartProbePy, ...unique]).catch(() => "{}");
    let parsed = {};
    try {
      parsed = JSON.parse(raw) || {};
    } catch {
      parsed = {};
    }
    return Object.fromEntries(unique.map((p) => [p, this.parseJson(parsed[p] || null)]));
  },

  formatReport(devPath, sm) {
    const meta = [sm?.model, sm?.serial ? `S/N: ${sm.serial}` : "", sm?.protocol ? `via ${sm.protocol}` : ""]
      .filter(Boolean)
      .join(", ");
    const header = meta ? `${devPath} (${meta})` : devPath;

    if (!sm || !sm.supported) {
      return `${header}\n  SMART Status : Not available / virtual block device`;
    }

    const tag = sm.level === "danger" ? "[CRITICAL]" : sm.level === "warn" ? "[WARNING]" : "[HEALTHY]";
    const lines = [
      header,
      `  Status          : ${tag} ${sm.summary} (SMART Assessment: ${sm.passed ? "PASSED" : "FAILED"})`,
    ];

    if (sm.reallocated > 0) lines.push(`  Reallocated     : ${sm.reallocated} sectors`);
    if (sm.runtimeBad > 0) lines.push(`  Runtime Bad Blk : ${sm.runtimeBad}`);
    if (sm.pending > 0) lines.push(`  Pending Sectors : ${sm.pending}`);
    if (sm.offlineUncorr > 0) lines.push(`  Offline Uncorr. : ${sm.offlineUncorr}`);
    if (sm.reportedUncorr > 0) lines.push(`  Reported Uncorr : ${sm.reportedUncorr}`);
    if (sm.endToEnd > 0) lines.push(`  End-to-End Err  : ${sm.endToEnd}`);
    if (sm.crcErrors > 0) lines.push(`  UDMA CRC Errors : ${sm.crcErrors}`);
    if (sm.scsiGrownDefects > 0) lines.push(`  Grown Defects   : ${sm.scsiGrownDefects}`);
    if (sm.nvmeCritWarn > 0 || sm.nvmeMediaErrs > 0 || sm.nvmePctUsed > 0) {
      lines.push(
        `  NVMe Health     : ${sm.nvmePctUsed}% used, ${sm.nvmeMediaErrs} media errors (warn=0x${sm.nvmeCritWarn.toString(16)})`,
      );
    }
    const telemetry = [];
    if (sm.tempC !== null) telemetry.push(`Temp: ${sm.tempC} C`);
    if (sm.powerOnHours !== null) telemetry.push(`Power-On: ${sm.powerOnHours} h`);
    if (telemetry.length) lines.push(`  Telemetry       : ${telemetry.join(" | ")}`);

    return lines.join("\n");
  },
};

window.Dropdown = {
  parseLabel(rawText) {
    let text = String(rawText || "").trim();
    let isCurrent = false;
    if (text.endsWith("[Current]")) {
      isCurrent = true;
      text = text.slice(0, -"[Current]".length).trim();
    }

    let depth = 0;
    let splitIdx = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && depth > 0) depth--;
      else if (depth === 0 && text.startsWith(" - ", i)) {
        splitIdx = i;
        break;
      }
    }

    if (splitIdx !== -1) {
      return {
        title: text.slice(0, splitIdx).trim(),
        desc: text.slice(splitIdx + 3).trim(),
        isCurrent,
      };
    }

    const parenMatch = text.match(/^([^(]+?)\s*\((.+)\)$/);
    if (parenMatch) {
      return {
        title: parenMatch[1].trim(),
        desc: parenMatch[2].trim(),
        isCurrent,
      };
    }

    return { title: text, desc: "", isCurrent };
  },

  enhance(selectEl) {
    if (!selectEl) return null;
    if (selectEl._pfWrapper) {
      this.refresh(selectEl);
      return selectEl._pfWrapper;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "pf-select";
    if (selectEl.classList.contains("w-100")) wrapper.classList.add("pf-select-full");
    if (selectEl.classList.contains("hidden-element")) wrapper.classList.add("hidden-element");

    selectEl.classList.add("pf-select-native");
    selectEl.tabIndex = -1;
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "pf-select-toggle";
    toggleBtn.setAttribute("aria-haspopup", "listbox");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.innerHTML =
      '<span class="pf-select-toggle-content"></span><span class="pf-select-arrow" aria-hidden="true"></span>';

    const menu = document.createElement("div");
    menu.className = "pf-select-menu hidden-element";
    menu.setAttribute("role", "listbox");

    wrapper.appendChild(toggleBtn);
    wrapper.appendChild(menu);

    selectEl._pfWrapper = wrapper;
    selectEl._pfToggle = toggleBtn;
    selectEl._pfMenu = menu;

    const setMenuOpen = (open) => {
      wrapper.classList.toggle("pf-select-open", open);
      menu.classList.toggle("hidden-element", !open);
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (toggleBtn.disabled) return;
      const willOpen = !wrapper.classList.contains("pf-select-open");
      this.closeAll(wrapper);
      setMenuOpen(willOpen);
      if (willOpen) {
        const selected = menu.querySelector(".pf-select-option-selected:not(:disabled)");
        selected?.scrollIntoView({ block: "nearest" });
      }
    });

    const moveFocus = (delta) => {
      const enabledOpts = Array.from(menu.querySelectorAll(".pf-select-option:not(:disabled)"));
      if (!enabledOpts.length) return;
      const activeIdx = enabledOpts.indexOf(document.activeElement);
      let nextIdx;
      if (activeIdx === -1) {
        const curIdx = enabledOpts.findIndex((btn) => btn.classList.contains("pf-select-option-selected"));
        nextIdx = curIdx !== -1 ? (curIdx + delta + enabledOpts.length) % enabledOpts.length : 0;
      } else {
        nextIdx = (activeIdx + delta + enabledOpts.length) % enabledOpts.length;
      }
      enabledOpts[nextIdx].focus();
    };

    toggleBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!wrapper.classList.contains("pf-select-open")) {
          this.closeAll(wrapper);
          setMenuOpen(true);
        }
        moveFocus(e.key === "ArrowDown" ? 1 : -1);
      }
    });

    menu.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Tab") {
        setMenuOpen(false);
      }
    });

    selectEl.addEventListener("change", () => this.refresh(selectEl));

    const observer = new MutationObserver(() => this.refresh(selectEl));
    observer.observe(selectEl, {
      childList: true,
      attributes: true,
      attributeFilter: ["class", "disabled"],
    });

    this.refresh(selectEl);
    return wrapper;
  },

  refresh(selectOrId) {
    const selectEl = typeof selectOrId === "string" ? $(selectOrId) : selectOrId;
    if (!selectEl) return;
    if (!selectEl._pfWrapper) {
      this.enhance(selectEl);
      return;
    }

    const wrapper = selectEl._pfWrapper;
    const toggleBtn = selectEl._pfToggle;
    const toggleContent = toggleBtn.querySelector(".pf-select-toggle-content");
    const menu = selectEl._pfMenu;

    wrapper.classList.toggle("hidden-element", selectEl.classList.contains("hidden-element"));
    wrapper.classList.toggle("pf-select-full", selectEl.classList.contains("w-100"));

    const opts = Array.from(selectEl.options);
    const isEmptyOnly = opts.length === 0 || (opts.length === 1 && opts[0].value === "");
    toggleBtn.disabled = Boolean(selectEl.disabled || isEmptyOnly);

    if (selectEl.selectedIndex < 0 && opts.length > 0) {
      selectEl.selectedIndex = 0;
    }

    const selectedOpt = opts[selectEl.selectedIndex] || opts[0];
    if (selectedOpt) {
      const parsed = this.parseLabel(selectedOpt.textContent);
      toggleContent.innerHTML =
        `<span class="pf-select-toggle-title">${escapeHtml(parsed.title)}</span>` +
        (parsed.desc ? `<span class="pf-select-toggle-desc">— ${escapeHtml(parsed.desc)}</span>` : "") +
        (parsed.isCurrent ? `<span class="pf-select-badge">Current</span>` : "");
    } else {
      toggleContent.innerHTML = '<span class="pf-select-toggle-desc">Select an option...</span>';
    }

    menu.innerHTML = opts
      .map((opt) => {
        const isSelected = opt.selected;
        const isDisabled = Boolean(opt.disabled || (opt.value === "" && opts.length === 1));
        const p = this.parseLabel(opt.textContent);
        return `
          <button type="button" class="pf-select-option${isSelected ? " pf-select-option-selected" : ""}${isDisabled ? " pf-select-option-disabled" : ""}" role="option" aria-selected="${isSelected}" data-value="${escapeHtml(opt.value)}" ${isDisabled ? "disabled" : ""}>
            <span class="pf-select-opt-header">
              <span class="pf-select-opt-title">${escapeHtml(p.title)}</span>
              ${p.isCurrent ? `<span class="pf-select-badge">Current</span>` : ""}
            </span>
            ${p.desc ? `<span class="pf-select-opt-desc">${escapeHtml(p.desc)}</span>` : ""}
          </button>`;
      })
      .join("");

    menu.querySelectorAll(".pf-select-option:not(:disabled)").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectEl.value = btn.getAttribute("data-value");
        this.closeAll();
        this.refresh(selectEl);
        toggleBtn.focus();
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  },

  closeAll(exceptWrapper = null) {
    document.querySelectorAll(".pf-select.pf-select-open").forEach((wrapper) => {
      if (wrapper === exceptWrapper) return;
      wrapper.classList.remove("pf-select-open");
      wrapper.querySelector(".pf-select-menu")?.classList.add("hidden-element");
      wrapper.querySelector(".pf-select-toggle")?.setAttribute("aria-expanded", "false");
    });
  },

  initAll() {
    document.querySelectorAll("select.form-input").forEach((sel) => this.enhance(sel));
  },
};

document.addEventListener("click", (e) => {
  if (!e.target.closest(".pf-select")) Dropdown.closeAll();
});

window.Modal = {
  callback: null,

  show(title, message, type = "alert", options = null, callback = null, btnText = null, isDanger = false) {
    const modal = $("generic-modal");
    if (!modal) return;

    Dropdown.closeAll();
    $("generic-modal-title").innerText = title;
    $("generic-modal-message").innerText = message;

    const inputContainer = $("generic-modal-input-container");
    const inputEl = $("generic-modal-input");
    const selectEl = $("generic-modal-select");
    const cancelBtn = $("generic-modal-cancel");
    const confirmBtn = $("generic-modal-confirm");

    inputContainer?.classList.toggle("hidden-element", type === "alert" || type === "confirm");
    inputEl?.classList.toggle("hidden-element", type !== "prompt");
    selectEl?.classList.toggle("hidden-element", type !== "select");
    cancelBtn?.classList.toggle("hidden-element", type === "alert");

    if (confirmBtn) {
      confirmBtn.innerText = btnText || (type === "alert" ? "OK" : "Confirm");
      confirmBtn.classList.toggle("btn-danger", Boolean(isDanger));
      confirmBtn.classList.toggle("btn-primary", !isDanger);
    }

    if (type === "prompt" && inputEl) {
      inputEl.value = options || "";
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 80);
    } else if (type === "select" && selectEl) {
      selectEl.innerHTML = (options || [])
        .map((opt) => `<option value="${escapeHtml(opt.v)}">${escapeHtml(opt.l)}</option>`)
        .join("");
      Dropdown.refresh(selectEl);
      setTimeout(() => selectEl._pfToggle?.focus(), 80);
    }

    this.callback = callback;
    modal.classList.remove("hidden-element");
  },

  close() {
    Dropdown.closeAll();
    $("generic-modal")?.classList.add("hidden-element");
    this.callback = null;
  },

  confirm() {
    const actionCallback = this.callback;
    const selectEl = $("generic-modal-select");
    const inputEl = $("generic-modal-input");

    const value =
      selectEl && !selectEl.classList.contains("hidden-element")
        ? selectEl.value
        : inputEl
          ? inputEl.value
          : "";

    this.close();
    if (actionCallback) actionCallback(value);
  },
};

window.customAlert = (title, message) =>
  Modal.show(title, message, "alert", null, null, "OK", false);

window.customConfirm = (title, message, confirmBtnText, onConfirm, isDanger = false) =>
  Modal.show(title, message, "confirm", null, onConfirm, confirmBtnText || "Confirm", isDanger);

window.customPrompt = (title, message, defaultValue, confirmBtnText, onConfirm) =>
  Modal.show(title, message, "prompt", defaultValue, onConfirm, confirmBtnText || "Submit", false);

window.customSelect = (title, message, options, confirmBtnText, onConfirm) =>
  Modal.show(title, message, "select", options, onConfirm, confirmBtnText || "Select", false);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.querySelector(".pf-select.pf-select-open")) {
      Dropdown.closeAll();
      return;
    }
    ["generic-modal", "add-dev-modal", "destroy-vol-modal"].forEach((id) =>
      $(id)?.classList.add("hidden-element"),
    );
    Modal.callback = null;
  } else if (
    e.key === "Enter" &&
    !$("generic-modal")?.classList.contains("hidden-element") &&
    document.activeElement === $("generic-modal-input")
  ) {
    e.preventDefault();
    Modal.confirm();
  }
});
