#!/bin/bash

echo '========================================'
echo '                                 +*++* '
echo '  ++++++++++++++++++++++++++   +===+== '
echo '++=-::::::::::::::::::::::-++ =-=+*+--+'
echo '++.........................=+=--++*=--+'
echo '++........::.....::........=+===+*+-==+'
echo '++........::.....::........=+-:+* =:-+ '
echo '++..========:::::--::::::..==-=*  =--  '
echo '++..=-----=-.....::........=+**     +  '
echo '++..=-----=-.....::........+**         '
echo '++..=-----=-.....::.......:**          '
echo '++..=-----==::::::-:::::::*++          '
echo '++..:--=--==-----==:::::-*-=+          '
echo '++.....---==------=....:*-.=+          '
echo '++........-=------=...-*-..=+          '
echo '++........-=------=..-*%=..=+          '
echo '++...:::::=========::*#=:..=+          '
echo '++...:::::::::::::-::--:...=+          '
echo '++........::.....::........=+          '
echo '++........::......:........=+          '
echo '++-:......................:++          '
echo ' +++++++++++++++++++++++++++           '
echo '        Mapwright - Installation'
echo '========================================'
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed."
    echo
    echo "Please download and install Node.js from:"
    echo "  https://nodejs.org/"
    echo
    echo "Choose the \"LTS\" version, install it, then run this script again."
    echo
    exit 1
fi

# Check Node.js version (need 18+)
NODE_VER=$(node --version)
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "[ERROR] Node.js $NODE_VER is too old. Version 18 or newer is required."
    echo
    echo "Please download the latest LTS version from:"
    echo "  https://nodejs.org/"
    echo
    exit 1
fi

echo "[OK] Node.js $NODE_VER found."

# Navigate to the directory containing this script
cd "$(dirname "$0")"

# Run npm install
echo
echo "Installing dependencies (this may take a minute)..."
echo
npm install

if [ $? -ne 0 ]; then
    echo
    echo "[ERROR] Installation failed. See the output above for details."
    echo
    exit 1
fi

# ── Texture Library ──────────────────────────────────────────────────────────
echo
echo '========================================'
echo ' Textures (Optional)'
echo '========================================'
echo ' Mapwright supports high-quality PBR textures from Polyhaven'
echo ' (free, CC0 licensed). The editor works without them.'
echo ' You can re-run install.sh at any time to download textures.'
echo
echo '  [R] Required only  - ~25 textures used by built-in props'
echo '  [A] All textures   - full Polyhaven library (700+)'
echo '  [S] Skip for now'
echo
printf 'Download textures? [R/A/S]: '
read TC
echo
case "$TC" in
  [Rr])
    node tools/download-textures.js --required
    if [ $? -ne 0 ]; then echo "[WARNING] Some downloads failed. Re-run install.sh to retry."; fi
    ;;
  [Aa])
    node tools/download-textures.js --all
    if [ $? -ne 0 ]; then echo "[WARNING] Some downloads failed. Re-run install.sh to retry."; fi
    ;;
  *)
    echo "  Skipped. Run ./install.sh again to download textures later."
    ;;
esac

echo
echo "===================================="
echo " Installation complete!"
echo " Run ./start.sh to launch Mapwright."
echo "===================================="
echo
