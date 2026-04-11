# Structa v0.4 — Cascade Edition

## Overview
A lightweight, web-based visualization tool for "Professional Services Cognition" impact testing, designed for the Rabbit R1 device. It visualizes a graph of interconnected cognition nodes and simulates how changes cascade through the system.

## Tech Stack
- **Frontend:** Vanilla HTML5, CSS3, JavaScript (no framework or build step)
- **Graphics:** HTML5 Canvas API for node-link diagram and particle effects
- **Fonts:** Inter and Space Grotemp via Google Fonts CDN

## Project Structure
- `index.html` — Main entry point with UI structure and styles
- `structa-cascade.js` — Core application logic (nodes, edges, animation, cascade engine)

## Running the App
The app is served as a static site using Python's built-in HTTP server:
- **Workflow:** "Start application" → `python3 -m http.server 5000`
- **Port:** 5000

## Deployment
Configured as a **static** deployment with `publicDir: "."` (root directory).

## Features
- **Run Test Cascade:** Simulates a "Mission Card" being processed through the node graph
- **Export Brief:** Generates a status summary in Markdown format
- **Impact Visualization:** Animates particle effects showing data flow between cognition nodes
- **Real-time Log:** Displays system events and impact entries
