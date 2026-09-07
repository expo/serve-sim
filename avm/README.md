# avm

A simple headless macOS VM client for Apple Silicon, supporting **hardware video encoding** (H.264, HEVC, ProRes) via paravirtualized VideoToolbox.

## Quick Start

```bash
# Build
swiftc -O -framework Virtualization -framework AppKit avm.swift -o avm
codesign --force --sign - --entitlements avm.entitlements avm

# For hardware video encoding: relax SIP (one-time, from Recovery)
# and register an AMFI exemption. See "Hardware Video Encoding" below.
# csrutil enable --without debug
# brew install retX0/tap/amfree && sudo amfree --path /path/to/avm/

# Create a VM (downloads the latest macOS IPSW automatically)
./avm install latest ~/VMs/dev.vbvm --cpus 6 --memory 8 --disk 128

# Or use an existing IPSW
./avm install ~/Downloads/macOS_15.ipsw ~/VMs/dev.vbvm

# Run it
./avm ~/VMs/dev.vbvm
```

## Usage

```
avm <path.vbvm>                          Run an existing VM
avm install <ipsw|latest> <path.vbvm>    Create and install a new VM
```

### Options

| Option | Description |
|---|---|
| `--cpus <n>` | CPU count (default: 4) |
| `--memory <n>` | RAM in GB (default: 4) |
| `--disk <n>` | Disk size in GB (default: 64, install only) |
| `--display <WxH>` | Resolution (default: 1920x1200) |
| `--headless` | Run without a GUI window |
| `--recovery` | Boot into macOS Recovery |
| `--no-accel` | Disable VideoToolbox/M2Scaler paravirtualization |
| `--no-audio` | Disable audio |

Options work in both install and run modes. In run mode, they override the values stored in the bundle's `config.json`.

IPSW files for specific macOS versions can be downloaded from [ipsw.me](https://ipsw.me) or [Apple's developer downloads](https://developer.apple.com/download/).

### Examples

```bash
# Install with custom specs
avm install latest ~/VMs/dev.vbvm --cpus 8 --memory 16 --disk 256

# Run with overridden CPU/memory
avm --cpus 4 --memory 8 ~/VMs/dev.vbvm

# Headless server mode
avm --headless ~/VMs/ci.vbvm

# Recovery mode
avm --recovery ~/VMs/dev.vbvm

# No hardware encoding acceleration
avm --no-accel ~/VMs/dev.vbvm
```

## Bundle Format

A `.vbvm` bundle is a directory:

```
dev.vbvm/
  Disk.img              # Main disk (sparse on APFS)
  HardwareModel         # VZMacHardwareModel serialized
  MachineIdentifier     # VZMacMachineIdentifier serialized
  AuxiliaryStorage      # NVRAM / boot data
  config.json           # VM settings
```

VirtualBuddy `.vbvm` bundles are also supported -- avm reads the `.vbdata/Config.plist` format as a fallback.

## Hardware Video Encoding

avm uses private Virtualization.framework APIs to attach paravirtualized VideoToolbox and M2Scaler accelerator devices. This gives the guest VM access to the host's hardware video encoder (Apple Video Encoder / AVE), enabling:

- H.264 and HEVC hardware encoding
- ProRes 422/4444 hardware encoding
- Hardware pixel format conversion and scaling

This requires additional setup:

### 1. Relax SIP (one-time, from Recovery Mode)

```bash
csrutil enable --without debug
```

This keeps SIP fully enabled except for the debug restriction, which allows AMFI policy exemptions for binaries with restricted (Apple-private) entitlements.

### 2. Install amfree

```bash
brew install retX0/tap/amfree
sudo amfree --path /path/to/avm/
```

This registers a CDHash-based AMFI exemption for binaries in the specified directory. **Must be re-run after every rebuild** since the CDHash changes.

### 3. Sign with entitlements

```bash
codesign --force --sign - --entitlements avm.entitlements avm
```

The entitlements file includes:

| Entitlement | Purpose |
|---|---|
| `com.apple.security.virtualization` | Base Virtualization.framework access |
| `com.apple.private.virtualization` | Access to restricted VM device types |
| `com.apple.virtualization.avp.videotoolbox` | VideoToolbox paravirtualized encoder |
| `com.apple.virtualization.avp.AppleM2ScalerDevice` | Hardware scaler/pixel converter |

### Without the entitlements

avm works fine without the hardware encoding setup -- it just won't attach accelerator devices, and VideoToolbox in the guest will fall back to software encoders. Use `--no-accel` to explicitly disable accelerators.

## Headless / Remote Access

For fully headless operation (no GUI window), you need remote access to the guest. On macOS Tahoe, the recommended setup is:

### 1. First boot: complete Setup Assistant via the GUI

The initial macOS setup requires the GUI window. Run the VM normally (without `--headless`) for the first boot and complete the setup.

### 2. Enable FileVault + Remote Login for SSH unlock

macOS Tahoe supports unlocking FileVault via SSH before login. With both **FileVault** and **Remote Login** (SSH) enabled in System Settings, the VM runs a lightweight SSH server at the login screen. Connect with password auth to unlock:

```
$ ssh 192.168.64.x
This system is locked. To unlock it, use a local
account name and password. Once successfully
unlocked, you will be able to connect normally.
Password:
System successfully unlocked.
```

After unlocking, Remote Management starts and VNC/RustDesk can connect to the login screen. You can then run the VM headless:

```bash
avm --headless ~/VMs/dev.vbvm
```

**Note:** Pre-login SSH only accepts passwords (not keys), and the VM must have a wired/paravirtualized network connection (not WiFi) at boot.

## Known Limitations

- **APFS required for install.** `avm install` must target an APFS (or HFS+) volume. The macOS restore service (`AMRestore`) fails on exFAT/FAT32 filesystems. You can move the bundle to another filesystem after installation.
- **Private API.** The accelerator APIs are undocumented and can change in any macOS update. They're accessed via `NSClassFromString` and KVC, so the binary won't crash if they're removed -- the VM will fall back to software encoding.
- **SIP modification required** for hardware encoding. `csrutil enable --without debug` requires a one-time boot into Recovery. Without it, AMFI will kill the binary on launch if it has restricted entitlements.
- **Re-run amfree after rebuilds.** The AMFI exemption is CDHash-based, so any recompilation invalidates it.
- **NAT networking only.** Virtualization.framework only supports NAT for macOS guests on Apple Silicon.

## Compatibility

- **Host:** Apple Silicon Mac, macOS Ventura or later
- **Guest:** macOS (any version supported by the host's Virtualization.framework)
- Tested on M4 Mac running macOS Tahoe with macOS Tahoe guests
