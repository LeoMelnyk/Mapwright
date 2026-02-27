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
echo '               Mapwright'
echo '========================================'
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed."
    echo "Please run ./install.sh first."
    echo
    exit 1
fi

# Navigate to the directory containing this script
SCRIPT_DIR="$(dirname "$0")"

# Check if dependencies are installed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "[ERROR] Dependencies are not installed."
    echo "Please run ./install.sh first."
    echo
    exit 1
fi

cd "$SCRIPT_DIR"

echo "Starting Mapwright..."
echo
echo "The editor will open in your browser at:"
echo "  http://localhost:3000/editor/"
echo
echo "Press Ctrl+C to stop the server when you are done."
echo

# Open browser after a short delay (in background)
(sleep 2 && open "http://localhost:3000/editor/" 2>/dev/null) &

# Start the server (blocking)
npm start
