# TTC 2000 — Route 103 Mount Pleasant North

A real-time TTC bus tracker and schedule board for **Line 103 Mount Pleasant North**, combining live GPS map visualization with distance approximation to key stops (including Home at Blythwood Rd & Stibbard Ave), arrival predictions, and daily timetables.

## Highlights & Features

- **Real-Time GPS Bus Tracking**:
  - Live positions of all buses on Line 103 rendered on an interactive Leaflet map.
  - Heading-oriented directional arrows rotating in real time with vehicle speed (km/h) and freshness.
  - Directional filtering (All, Northbound, Southbound).
  - Bus ripple pulse animations and rich interactive popups.

- **Proximity & Stop Approximation**:
  - Distance approximation to all tracked stops formatted as `At Stop`, meters (`m`), or kilometers (`km`).
  - Home Quick Pills in top navigation bar displaying the closest approaching bus, distance, and ETA to:
    - 🟢 **Home Northbound** (Mt Pleasant Rd at Blythwood Rd)
    - 🟣 **Home Southbound** (Mt Pleasant Rd at Stibbard Ave)
  - One-click map fly-to for any stop or Home location.

- **Next Bus Arrival Predictions**:
  - Queries real-time TTC / UmoIQ prediction feeds for arrival countdowns.

- **Daily Timetables**:
  - Up-to-date daily timetable schedule board showing the previous departure (marked missed) and highlighted upcoming departure.
  - Multi-tier caching (in-memory + 12h localStorage + network retries + static fallback).

- **Architecture**:
  - Pure static front-end architecture (`index.html`, CSS, and vanilla ES6 JS modules).
  - Works with any static file server or GitHub Pages without requiring a backend server or API keys.

## Running Locally

Serve statically on port 8080:

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080) in your browser.
