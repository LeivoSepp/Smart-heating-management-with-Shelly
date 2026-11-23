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
| `settings.js` | Configurations, days, device types and script entries shared by the tests. |
| `fixtures/` | Elering price answers (15 minute prices, `fields=ee`) and an Open-Meteo forecast, downloaded from the real services. |
| `espruino/` | The memory test, see [Memory](#memory). |

The forecast is weather data by [Open-Meteo.com](https://open-meteo.com/), unchanged, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The Elering files are ISO-8859-1, as Elering serves them. The only character outside ASCII is in the header line, which the script skips. Each file covers the planned day and a few hours around it. The simulation answers a request with the rows from `start` to `end`, both included. Elering does the same, checked against the live service with the address the script builds: one day gives 97 rows. The 25 hour day is planned from prices only because of that last row.

The tests pin what the script does today, also where that differs from the price list, the calendar or its own comments. `oracle.js` follows the price list and the calendar day, so these cases are pinned with literal values, without it:

- Imatra summer or winter hours follow the clock of the device, not the hour being priced.
- The plan of the 23 hour day 2026-03-29 contains hour 0 of the next day.
- Without a period, the first quarter of the next day counts as hour 0.
- A Gen2 Pro on firmware 1.4.3 stays in KVS mode, although the comment in the script names 1.4.3 as the first firmware with Virtual Components. The script uses them from 1.4.4 on.

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
| `rpcFail` | RegExp of RPC method names that fail, matched against the name as the script writes it (`KVS.set`, `KVS.Get`) |
| `deviceInfo` | Result of `Shelly.getDeviceInfo()` |
| `scripts`, `scriptId` | Scripts on the device, `[{ id, name, running, enable }]`, and the ID of the running one |
| `code` | Source text to run instead of the heating script |

## What the simulated device enforces

"Gen4" below is a Shelly 1PM Mini Gen4 on firmware 2.2.1, measured in November 2026. "Plus 1PM" is a Shelly Plus 1PM on firmware 1.7.6.

| Limit or behaviour | Value | Source |
|---|---|---|
| RPC calls in flight per script | 5, counted only within one synchronous run, see below | Shelly docs, Script Language Reference, Resource Limits. Gen4: the sixth call stops the script with "Too many calls in progress". |
| Active timers per script | 5 | Shelly docs, same page. Gen4: the sixth timer stops the script with "Too many running timers." |
| Schedules per device | 20, then `-108` | Shelly docs, Schedule, and Gen4. On a device the job that updates the firmware automatically is one of the 20. The simulated device starts with no schedules. |
| Calls in one schedule | 5, then `-103` | Shelly docs, Schedule, and Gen4 |
| Virtual components per device, the group included | 10, then `-108` | Shelly docs, Virtual, and Gen4: a group and nine components were accepted, the next one was refused |
| Virtual component ID | 200 to 299, else `-103`. Each ID once per component type, else `-106`. | Shelly docs, Virtual, and Gen4 |
| `Virtual.Delete` of a missing component | `-105` | Gen4 |
| KVS value | 253 bytes of UTF-8, every `"` counted twice, else `-103` | Shelly docs, KVS, give 253. Plus 1PM and Gen4: "length should be less than 255". Gen4: 233 characters with 20 quotes fit, 126 times "õ" fit, one more of either did not. |
| KVS key | 42 characters, else `-103` | Shelly docs, KVS, and Gen4 |
| KVS keys per device | 50, then `-108` | Shelly docs, KVS, and Gen4 |
| `KVS.Get` of a missing key | `-105` | Plus 1PM and Gen4 |
| `Schedule.Delete` of a missing ID | `-103` | Device log in the discussion of pull request #11, and Gen4 |
| `Schedule.Update` of a missing ID | `-105` | Device log in the discussion of pull request #11, and Gen4 |
| ID of a new schedule | the highest existing ID plus one | Gen4: with schedules 2 and 3, deleting 3 gave 3 again, deleting 2 gave 4 |
| Scripts per device | 10, then `-108` | Gen4: the eleventh script was refused with "Reached the maximum 10 of stored scripts" |
| ID of a new script | the lowest free one | Gen4 |
| Autostart of a script made by `Script.Create` | off | Gen4 |
| `Script.Start`, `Script.Stop` | answer `{ was_running }` | Shelly docs, Script, and Gen4 |
| Callback of an RPC call | on success a result and the message `""`, on failure the result `undefined`, a code and a message | Gen4 |
| `Timer.clear` | `true` for a pending timer, otherwise `undefined` | Gen4 |
| `HTTP.GET` answer | Elering in `body_b64`, Open-Meteo in `body` | Shelly docs, HTTP: `body` for text and JSON, `body_b64` for binary data. Elering answers with `application/octet-stream`. |

The simulated devices are a Shelly Plus 1PM (Gen2, KVS mode), a Shelly Pro 1PM (Gen2, Virtual Component mode), a Shelly 1PM Gen3 and a Shelly 1PM Mini Gen4 (both Virtual Component mode). The Gen2 and Gen3 devices report firmware 1.7.6, the Gen4 reports 2.2.1. They differ only in what `Shelly.getDeviceInfo()` answers, which decides the mode. The limits and error codes are the same for all of them.

### Assumed error codes

No source gives the error code of an `HTTP.GET` that fails. The simulation answers it with `ERR_HTTP_FAILURE_ASSUMED`. The script only tests for a non-zero code, so the number does not change a test result.

The same holds for a method that `rpcFail` makes fail. The tests use it for `Script.List`, `Script.Stop` and `Script.PutCode`. No device was seen to refuse these while a watchdog was installed (the one refusal seen, `Script.PutCode` of code outside ASCII, is under [What is not simulated](#what-is-not-simulated)), so the simulation answers with `ERR_RPC_FAILURE_ASSUMED`, and the script only tests for a missing result or a non-zero code.

More than 5 RPC calls in flight, more than 5 active timers, a run that never comes to rest and an exception in a timer or RPC callback end a test with `sim.crashed` set. An exception while the script loads fails the test directly, and so does an RPC method the simulation does not know.

## What is not simulated

A passing test does not prove these. They need a real device.

- The script engine. Node accepts JavaScript that the engine of the device does not.
- Whether the script fits in the memory of a device. [Memory](#memory) compares one version of the script with another.
- The call stack of the engine. A Shelly Plus 1PM stopped a script at about five nested calls (seen in November 2026, firmware not recorded).
- Time taken by RPC and HTTP answers. Every answer arrives in the same simulated millisecond, so the limit of 5 calls only counts calls sent before the script yields. Calls that overlap over time on a device are not counted.
- Schedules firing. A schedule is stored but never runs, and the relay is never switched. Heating time is worked out from the timespec and the auto-off delay.
- Random delays. `Math.random()` always returns 0, so the delay of the Elering request and the start jitter never happen.
- `Script.Start` running the code of the started script. The watchdog is run by the tests on a second simulated device.
- The size of an HTTP answer.
- Paging of `Shelly.GetComponents`. The simulation returns every component in one answer. So did the Gen4 with ten components. A Shelly 1 Mini Gen3 on firmware 2.0.3 returned six of ten when the configuration was asked for as well.
- `Script.PutCode` refusing characters outside ASCII, as seen on a Plus 1PM. The Gen4 accepted them.
- Differences between device generations and firmware versions. Most rows of the table above were measured on a Gen4 only and are assumed to hold on Gen2 and Gen3. One known difference: a Gen2 Plus has no virtual components, yet the simulation would create them there.

## Memory

```
tests/espruino/build-espruino.sh
npm run test:memory
```

The memory test runs one calculation of the script in Espruino, the interpreter the Shelly script engine is built on, and reads how much of the engine's memory the script takes. `npm test` does not run it. It takes about half a minute, most of it for the one case with a timer that fires 8571 times.

| File | What it is |
|---|---|
| `build-espruino.sh` | Builds Espruino for Linux in Docker into `tests/espruino/bin/`, from a fixed Espruino commit and a fixed Debian image. The binary is 32-bit (`gcc -m32`), so a memory block is 14 bytes as on the devices. |
| `espruino-shelly.patch` | Applied to Espruino before the build: a counter of the highest memory use, a clock the test can set, a memory size given at start and the loading of several files into one interpreter. This one file is under the Mozilla Public License 2.0, as Espruino is. The rest of the repository is under the MIT licence. |
| `script-memory.js` | The test: three sets of settings on five days, with the numbers of version 4.9 for each, and a few tiny scripts that check the simulated device itself. |
| `engine.js` | Runs a case first in Node, then twice in Espruino: once to measure, once to compare with the Node run. |
| `shelly-device.js` | The simulated device inside Espruino. It answers each RPC call and each status or configuration read with the answer the same one got in Node. |
| `one-cycle.js` | Runs one calculation and prints the result. |

`ESPRUINO_WORKDIR` keeps the Espruino sources between builds, otherwise `build-espruino.sh` puts them in a temporary directory and removes it.

The GitHub Action builds Espruino once, in about 30 seconds, and keeps it in the cache until the build script or the patch changes. GitHub also drops a cache that was not used for a week, and the next run then builds Espruino again.

### What is measured

Every case runs in KVS mode on a simulated Shelly Plus 1PM that has only the settings in KVS, so the calculation includes the install of the watchdog. Virtual Component mode and the first install without settings are not measured.

Two numbers are read, both counted from the moment the simulated device is ready and the script has not been loaded yet:

- **Peak**: the most memory in use at one moment while the script loads and plans, checked at every allocation. The garbage collector does not run between the callbacks, so objects that refer to each other, which only the collector frees, stay in the peak until the end. Version 4.9 leaves none: with a collection after every callback its numbers are the same.
- **Retained**: what is still in use after the calculation.

The simulated device keeps its clock, its counters and its queue of pending timers and RPC answers in memory it took before that moment, so they are not in the numbers. On a Gen4 a second and a third pending timer added nothing to the memory of a script either. The test checks this on itself: a script that is one empty function retains 112 bytes, and exactly as much with five timers that have fired, with three pending timers, with three RPC answers and with a timer that fires 8571 times.

Every RPC answer and every status or configuration read reaches the script as a new copy, as on a device. The test checks this on itself as well: a script that keeps an answer or a read retains as much as a script that keeps the same value written out in its code.

Espruino makes the object of a built-in such as `Date` or `JSON` when a script first uses it, in the memory of the script. A Gen4 does the same, with one exception: the methods of a string, a number and a boolean cost nothing there. The simulated device follows the Gen4, and the test holds the cost of a first use next to what the Gen4 gave:

| First use of | Gen4, bytes | Test, bytes |
|---|---|---|
| A method of a string, a number, a boolean or an array | 0 | 0 |
| `Date.now()` | 28 | 28 |
| `new Date()` | 98 | 98 |
| `JSON` | 28 | 28 |
| `console.log` | 42 | 42 |
| A caught `Error` | 112 | 112 |
| A typed array (`Float64Array`, `Float32Array`, `Uint32Array`, `Uint16Array`, `Uint8Array`), each type | 112 | 112 |
| `Math` | 28 | 0 |
| `Number(...)`, `String(...)`, `Object.keys`, `Array.isArray` | 42 each | 0 |
| `new Array(...)` | 112 | 0 |

The last three rows are free in the test because these objects exist there before the script loads: the simulated device uses `Math`, `Object` and `Array` itself, and making the methods of strings and numbers free makes `Number` and `String` free as well. Version 4.9 uses `Math` and `Number(...)`, 70 bytes on a Gen4 that the test leaves out. A change that adds or drops one of the objects of these three rows is not seen by the test.

What stays in the numbers are the function calls of the simulated device. They are JavaScript here and firmware code on a device, and what the calls of the firmware cost a script was not measured. In the retained memory that part is always the same: an empty script retains 84 bytes and one empty function with one timer and one RPC answer retains 112, as much as the function alone.

In the peak that part depends on where the script is when it reaches the peak. The test holds the peak of the same work in seven places:

| Where the work is done | Peak in bytes |
|---|---|
| While the script loads | 1 848 |
| In a timer callback | 2 156 |
| In the callback of an RPC call | 2 268 |
| While the script loads, with the memory still held during `Timer.set` | 2 324 |
| In a timer callback, with the memory still held during `Timer.set` | 2 632 |
| In the callback of an RPC call, with the memory still held during `Timer.set` | 2 744 |
| In the callback of an RPC call, with the memory still held during a configuration read | 2 912 |

So the simulated device adds nothing while the script loads, about 0.3 kB in a timer callback and about 0.4 kB in the callback of an RPC call, where the answer is a part of it. While the script calls into the device it adds about 0.5 kB more in `Timer.set` and about 0.6 kB more in a configuration read, of which the answer is about 0.1 kB. `Shelly.call` is a function of the simulated device in the same way. Version 4.9 reaches its peak in the callback of the Elering answer. The peaks of two versions can be compared when both reach it in the same kind of place. When a change moves work between loading, callbacks and calls to the device, up to about 1 kB of the difference can come from the simulated device, and the change has to be measured on a device.

The memory Espruino gets for the test is 5000 blocks, far more than a device has, so a case never fails for lack of memory. The case with the timer that fires 8571 times gets 1000 blocks: the counter of the peak walks through the whole memory at every allocation, and with 5000 blocks that case alone takes a minute.

In Espruino the script must make the same RPC calls and reads in the same order as in Node. The second run in Espruino also compares the parameters of every call and the arguments of every read with the Node run and reports a difference. One value is left out of that: `LastCalculation` in `SmartHeatingSys`, a date text the two engines write differently. Espruino also writes a number with at most 11 decimal places, 1/3 as `0.33333333333`, and text outside ASCII byte by byte. A number that needs more places or such a text in the parameters of a call is therefore reported as a difference. Version 4.9 sends neither in KVS mode.

`script-memory.js` holds the peak and the retained memory of version 4.9 for every case, between 15 512 and 15 960 bytes of peak and 3 752 to 3 780 bytes retained. A change that moves any of them fails the test until the table is updated, so a gain or a loss shows in the pull request.

### How the numbers relate to a device

Measured in November 2026 on a Shelly Plus 1PM (firmware 1.7.6), a Shelly Plus 1 (1.7.5) and a Shelly 1PM Mini Gen4 (2.2.1), with `Script.GetStatus`:

- A block is 14 bytes on all three. A variable name costs one block for its first 4 characters and one for every 10 after that: 1 to 4 characters 14 bytes, 5 to 14 characters 28, 15 to 24 characters 42. Espruino gives the same numbers.
- Comments and the length of a function body take no script memory on any of the three, also inside a function. The test loads the script the same way.
- All scripts of a device share one memory of about 25 200 bytes, on the Gen2 devices and on the Gen4.

The device needs more than Espruino for the same script. A Shelly Plus 1PM reported a peak of about 22 700 bytes for version 4.9, on other days and with other settings than the cases here. So the numbers of this test compare one version of the script with another. They do not tell whether a script fits on a device.

The test does not see the depth of the call stack or the space the script text takes on the device. A script of 48.9 kB restarted a Shelly Plus 1PM while it was loaded.
