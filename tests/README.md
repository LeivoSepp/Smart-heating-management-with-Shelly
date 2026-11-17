# Tests

The tests run `SmartHeatingWidthShelly.js` unchanged in Node, against a simulated Shelly device. Nothing here is loaded to a device.

```
npm test
```

Node 22 or newer, no dependencies. `node --test` and running one file work as well. The script plans by the local time of the device, so `harness.js` sets the time zone of the test process to Europe/Tallinn. The time zone of the machine does not matter.

## Files

| File | What it is |
|---|---|
| `characterization.test.js` | The behaviour of the script as it is today: settings in KVS, heating time, relay, hourly planning, fallback, schedule bookkeeping, watchdog, Virtual Component mode, network fees. |
| `harness.test.js` | Checks that the simulated device enforces the limits listed below. |
| `harness.js` | The simulated device: `Shelly.call`, `Timer`, KVS, schedules, virtual components, scripts, a fake clock and HTTP answers from `fixtures/`. |
| `limits.js` | Device limits and RPC error codes used by the simulation. |
| `oracle.js` | Expected hours and Elektrilevi fees calculated from the price file and the Elektrilevi price list, without the code of the script. |
| `settings.js` | Configurations, days and device types shared by the tests. |
| `fixtures/` | Elering price answers (15 minute prices, `fields=ee`) and an Open-Meteo forecast, downloaded from the real services. |

The Elering files are ISO-8859-1, as Elering serves them. The only character outside ASCII is in the header line, which the script skips. Each file covers the planned day and a few hours around it. The simulation answers a request with the rows from `start` to `end`, both included. Elering does the same, checked against the live service with the address the script builds: one day gives 97 rows. The 25 hour day is planned from prices only because of that last row.

The tests pin what the script does today, also where that differs from the price list or the calendar. `oracle.js` follows the price list and the calendar day, so these cases are pinned with literal values, without it:

- On a winter weekend morning the script charges the weekday peak rate.
- Imatra summer or winter hours follow the clock of the device, not the hour being priced.
- The plan of the 23 hour day 2026-03-29 contains hour 0 of the next day.
- Without a period, the first quarter of the next day counts as hour 0.

The network fee tests call `fFee` and set `_.prov` and `c.pack` inside the script, because the fee has no other way out of it.

## Options of `createShelly`

| Option | Meaning |
|---|---|
| `now` | ISO time of the device clock at start |
| `kvs` | KVS content at start, `{ key: stringValue }` |
| `schedules` | Schedules at start, `{ id: { timespec, calls } }` |
| `components` | Virtual components at start, `[{ key, status: { value }, config }]` |
| `elering` | Price fixture |
| `temperatures` | Forecast temperatures instead of the fixture |
| `httpFail` | RegExp of URLs whose `HTTP.GET` fails |
| `deviceInfo` | Result of `Shelly.getDeviceInfo()` |
| `scripts`, `scriptId` | Scripts on the device, `[{ id, name, running, enable }]`, and the ID of the running one |
| `code` | Source text to run instead of the heating script |

## What the simulated device enforces

| Limit or behaviour | Value | Source |
|---|---|---|
| RPC calls in flight per script | 5, counted only within one synchronous run, see below | Shelly docs, Script Language Reference, Resource Limits |
| Active timers per script | 5 | Shelly docs, Script Language Reference, Resource Limits |
| Schedules per device | 20 | Shelly docs, Schedule |
| Calls in one schedule | 5 | Shelly docs, Schedule |
| Virtual components per device, the group included | 10 | Shelly docs, Virtual: "a limit of 10 instances per device". That the group counts is taken from the discussion of pull request #11, not measured. |
| Virtual component ID | 200 to 299, each ID once per component type | Shelly docs, Virtual |
| KVS value | 253, every `"` counted twice | Shelly docs, KVS, give 253 without a unit. The double count was measured on a Shelly Plus 1PM: "length should be less than 255". Counting other characters in UTF-8 bytes is assumed. |
| KVS key | 42 characters | Shelly docs, KVS, give 42 without a unit |
| KVS keys per device | 50 | Shelly docs, KVS |
| `KVS.Get` of a missing key | `-105` | Measured on a Shelly Plus 1PM, firmware 1.7.6 |
| `Schedule.Delete` of a missing ID | `-103` | Device log in the discussion of pull request #11 |
| `Schedule.Update` of a missing ID | `-105` | Device log in the discussion of pull request #11 |
| ID of a new schedule | the lowest free one | Device log in the discussion of pull request #11: the ID of a deleted schedule was given to the next one |
| `Script.Start`, `Script.Stop` | answer `{ was_running }` | Shelly docs, Script |
| Autostart of a script made by `Script.Create` | off | Assumed. The Shelly docs give no default. |
| ID of a script made by `Script.Create` | the highest existing ID plus one | Assumed |
| `HTTP.GET` answer | Elering in `body_b64`, Open-Meteo in `body` | Shelly docs, HTTP: `body` for text and JSON, `body_b64` for binary data. Elering answers with `application/octet-stream`. |

The simulated devices are a Shelly Plus 1PM (Gen2, KVS mode), a Shelly Pro 1PM (Gen2, Virtual Component mode) and a Shelly 1PM Gen3 (Virtual Component mode). All three report firmware 1.7.6.

### Assumed error codes

No source gives an error code for these cases. The simulation answers all of them with `ERR_ASSUMED`. The script only tests for a non-zero code, so the number does not change a test result, but it is an assumption until someone reads it from a device.

- A full limit: schedules, calls in a schedule, virtual components, KVS value, KVS key, number of KVS keys.
- A virtual component ID that is taken or out of range, and `Virtual.Delete` of a missing component.
- An `HTTP.GET` that fails.

More than 5 RPC calls in flight, more than 5 active timers, a run that never comes to rest and an exception in a timer or RPC callback end a test with `sim.crashed` set. What the device itself does at the first two is not documented. An exception while the script loads fails the test directly, and so does an RPC method the simulation does not know.

## What is not simulated

A passing test does not prove these. They need a real device.

- The script engine. Node accepts JavaScript that the engine of the device does not.
- Memory use and the size of the script.
- The call stack of the engine. A Shelly Plus 1PM stopped a script at about five nested calls (seen in November 2026, firmware not recorded).
- Time taken by RPC and HTTP answers. Every answer arrives in the same simulated millisecond, so the limit of 5 calls only counts calls sent before the script yields. Calls that overlap over time on a device are not counted.
- Schedules firing. A schedule is stored but never runs, and the relay is never switched. Heating time is worked out from the timespec and the auto-off delay.
- Random delays. `Math.random()` always returns 0, so the delay of the Elering request and the start jitter never happen.
- `Script.Start` running the code of the started script. The watchdog is run by the tests on a second simulated device.
- The size of an HTTP answer.
- Paging of `Shelly.GetComponents`. The simulation returns every component in one answer.
- `Script.PutCode` accepting only ASCII.
- Other firmware versions and device generations than the ones named above.
