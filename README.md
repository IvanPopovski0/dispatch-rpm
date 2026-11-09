# Dispatch RPM

A desktop tool for quoting truckloads. Enter the truck's location, pickup and delivery ZIP codes, and the broker's offer to see the mileage, rate per mile, and whether the load is worth taking.

![Dispatch RPM](docs/screenshot.png)

## Features

Dispatch RPM has two modes:

**Simple** is intended for newer dispatchers. It calculates the trip and gives a recommendation: take the offer, negotiate a higher rate, or pass. It also suggests what to quote back to the broker.

**Advanced** gives you more control over your numbers, including:

- Custom target and minimum rates per mile
- Loaded and all-in rates, including empty miles
- Estimated driving time
- Saved quotes and rate history
- Daily, weekly, monthly, and lane averages
- CSV export

Both modes share the same load information, so you can switch between them without starting over.

Other features include automatic ZIP-to-ZIP mileage, company rates, and national rate references. Quotes and settings are stored locally.

## Getting started

### Windows

Prebuilt Windows releases can be downloaded from the [Releases](../../releases) page once published.

### Running from source

Requires Python 3.10 or newer. No additional Python packages are needed.

From the project directory:

```bash
python -m dispatch_rpm
```

The app opens in a browser or a separate application window if a supported browser is installed.

Additional options:

```bash
python -m dispatch_rpm --no-window
python -m dispatch_rpm --port 8080
python -m dispatch_rpm --offline-rates
```

## Rates

National reference rates are taken from DAT's public weekly market reports, with fuel adjustments based on U.S. diesel prices from the EIA.

The app periodically checks for updated figures and keeps the last accepted rates when newer data isn't available.

You can also enter rates manually or use company-provided rates for individual truck types. Company rates can be adjusted for changes in diesel prices.

National averages are a reference, not a substitute for knowing individual lanes and markets.

## Data

Quotes, settings, and rate history are stored in a local SQLite database.

| Platform | Database location |
|---|---|
| Windows | `%APPDATA%\DispatchRPM\dispatch.db` |
| macOS | `~/Library/Application Support/DispatchRPM/dispatch.db` |
| Linux | `~/.local/share/dispatch-rpm/dispatch.db` |

The application runs its HTTP server on `127.0.0.1`.

## Development

The backend uses Python's standard library. The frontend is plain HTML, CSS, and JavaScript, without a framework or build step.

Run the backend tests:

```bash
python -m unittest discover -s tests
```

Run the JavaScript tests (Node.js 20+):

```bash
npm test
```

To build the executable:

```bash
pip install pyinstaller
python build.py
```

Builds are platform-specific. The output is placed in `dist/`.

## License

MIT. See [LICENSE](LICENSE).

Mileage routing uses [OSRM](https://project-osrm.org/) and [OpenStreetMap](https://www.openstreetmap.org/copyright) data. Diesel prices are sourced from the EIA through [FRED](https://fred.stlouisfed.org/series/GASDESW). National rate references come from publicly available DAT Freight & Analytics reports.

This project is not affiliated with DAT.
