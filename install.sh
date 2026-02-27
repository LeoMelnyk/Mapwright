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

echo
echo "===================================="
echo " Installation complete!"
echo " Run ./start.sh to launch Mapwright."
echo "===================================="
echo
