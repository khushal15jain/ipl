#!/bin/bash
echo "🏏 IPL Auction — Starting..."
echo ""
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install from https://nodejs.org"
    exit 1
fi
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi
echo "🚀 Starting server at http://localhost:3000"
echo "   Database: auction.db (auto-created)"
echo ""
node server.js
