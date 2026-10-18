name: CricHD Playlist and Schedules

on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - uses: actions/checkout@v4

      - name: Install Xvfb, Chrome, and Windscribe VPN
        run: |
          sudo apt-get update
          sudo apt-get install -y xvfb google-chrome-stable wget
          # Download Windscribe CLI
          wget -O windscribe-cli.deb https://windscribe.com/install/linux/deb_amd64
          sudo dpkg -i windscribe-cli.deb || sudo apt-get install -f -y
          # Login to Windscribe using a free account (You need to create a free account)
          # Replace 'YOUR_USERNAME' and 'YOUR_PASSWORD' with your Windscribe free account details
          windscribe login
          windscribe connect
          curl -s https://httpbin.org/ip

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: |
          npm install
          npx playwright install --with-deps chromium
          npx playwright install chromium

      - name: Run scraper
        run: |
          xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
            node scrape.js
            
          echo "--- Playlist Preview ---"
          head -n 10 playlist.m3u || true

      - name: Upload Playlist Artifact
        uses: actions/upload-artifact@v4
        with:
          name: crichd-playlist
          path: playlist.m3u

      - name: Upload Schedule Artifact
        uses: actions/upload-artifact@v4
        with:
          name: crichd-schedule
          path: schedule.json
