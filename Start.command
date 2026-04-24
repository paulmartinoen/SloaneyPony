#!/bin/bash
cd ~/Documents/SloaneyPony

# Kill any existing Node process on port 3001 before starting fresh
EXISTING_PID=$(lsof -ti :3001)
if [ -n "$EXISTING_PID" ]; then
  echo "Killing existing Node process (PID $EXISTING_PID) on port 3001..."
  kill -9 $EXISTING_PID
  sleep 1
fi

# Start server in foreground so you can see logs and errors
node server.js &
SERVER_PID=$!
sleep 2

# Verify the server actually came up
if ! lsof -i :3001 > /dev/null; then
  echo "ERROR: Server failed to start. Check for errors above."
  read -p "Press Enter to close..."
  exit 1
fi

echo "Server running (PID $SERVER_PID). Opening Chrome..."
open -a "Google Chrome" http://localhost:3001

# Keep the Terminal window open so you can see server logs
wait $SERVER_PID
