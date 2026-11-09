/*
Created by Leivo Sepp, 2024-2025
Licensed under the MIT License
https://github.com/LeivoSepp/Smart-heating-management-with-Shelly
 
This Shelly script is designed to retrieve energy market prices from Elering and
activate heating during the most cost-effective hours each day, employing various algorithms. 
 
1. Dynamic calculation of heating time for the next day based on weather forecasts.
2. Division of heating into time periods, with activation during the cheapest price slots within each period (hours, or 15 to 240 minutes with SlotMinutes).
3. Utilization of min-max price levels to maintain the Shelly system consistently on or off.
The script executes daily after 23:45 to establish heating timeslots for the following day.
*/

/* Electricity transmission fees (EUR/MWh) excluding VAT.
Elektrilevi https://elektrilevi.ee/en/vorguleping/vorgupaketid/eramu 
Imatra https://imatraelekter.ee/vorguteenus/vorguteenuse-hinnakirjad/
Latvia https://sadalestikls.lv/en/tarifi
*/
function pack() {
    return {
        VORK1: { p: "Elektrilevi", dRt: 77.2, nRt: 77.2, dMRt: 77.2, hMRt: 77.2 },
        VORK2: { p: "Elektrilevi", dRt: 60.7, nRt: 35.1, dMRt: 60.7, hMRt: 35.1 },
        VORK4: { p: "Elektrilevi", dRt: 36.9, nRt: 21, dMRt: 36.9, hMRt: 21 },
        VORK5: { p: "Elektrilevi", dRt: 52.9, nRt: 30.3, dMRt: 81.8, hMRt: 47.4 },
        PARTN24: { p: "Imatra", dRt: 60.7, nRt: 60.7, dMRt: 60.7, hMRt: 60.7 },
        PARTN24PL: { p: "Imatra", dRt: 38.6, nRt: 38.6, dMRt: 38.6, hMRt: 38.6 },
        PARTN12: { p: "Imatra", dRt: 72.4, nRt: 42, dMRt: 72.4, hMRt: 42 },
        PARTN12PL: { p: "Imatra", dRt: 46.4, nRt: 27.1, dMRt: 46.4, hMRt: 27.1 },
        PAMATA1: { p: "Lv", dRt: 39.62, nRt: 39.62, dMRt: 39.62, hMRt: 39.62 },
        SPECIAL1: { p: "Lv", dRt: 158.48, nRt: 158.48, dMRt: 158.48, hMRt: 158.48 },
        NONE: { p: "None", dRt: 0, nRt: 0, dMRt: 0, hMRt: 0 },
    }
}
/*
Charges billed on top of the market price and the network fee, EUR/MWh without VAT, and the VAT rate.
Used by MaxFullPrice. Estonia 2026: renewable energy 8.4, excise 2.1, security of supply 7.58, balancing capacity 3.73.
*/
function tax() {
    return {
        ee: { fix: 21.81, vat: 0.24 },
    }
}
/****** INITIAL SETTINGS ******/
/* 
After the initial run, all user settings are stored in the Shelly 1) KVS or 2) Virtual components (in case virtual components are supported).
To modify user settings, you’ll need to access the Shelly KVS via: Menu → Advanced → KVS on the Shelly web page.
Once you’ve updated the settings, restart the script to apply the changes or wait for the next scheduled run.
 
TimePeriod: Heating Period is the time during which heating time is calculated. (0 -> only min-max price used, 24 -> period is one day).
HeatingTime: Heating Time is the duration of the cheapest slots within a Heating Period when the heating system is activated, or the duration of heating in a day in case of internet connection failure.
IsForecastUsed: true/false - Using weather forecast to calculate heating duration (only with a Heating Period).
*/
/* The device's script engine overflows its stack at about five nested JavaScript calls (an RPC or timer
   callback counts as the first). Every continuation goes through a callback or wait(), and the hot
   loops stay inline. Keep new code within four nested calls from a callback. */
let c = {
    tPer: 24,       // KVS:TimePeriod VC:Heating Period (h) 24/12/6/0
    hTim: 10,       // KVS:HeatingTime VC:Heating Time (h/period)
    isFc: false,    // KVS:IsForecastUsed VC:Forecast Heat
    pack: "VORK2",  // KVS:EnergyProvider VC:Network Package (NONE, VORK1, VORK2, VORK4, VORK5, PARTN24, PARTN24PL, PARTN12, PARTN12PL, PAMATA1, SPECIAL1)
    lowR: 1,        // KVS:AlwaysOnPrice VC:Heat On (min price) (EUR/MWh)
    higR: 300,      // KVS:AlwaysOffPrice VC:Heat Off (max price) (EUR/MWh)
    fulR: 0,        // KVS:MaxFullPrice (optional) VC: N/A, heat off if the full price (market + network + charges, VAT included) is higher (EUR/MWh), 0 = not used
    Inv: false,     // KVS:InvertedRelay VC:Inverted Relay
    rId: 0,         // KVS:RelayId VC: N/A, always first relay (0)
    cnty: "ee",     // KVS:Country VC:Market Price Country (ee, fi, lv, lt)
    hCur: 0,        // KVS:HeatingCurve VC:Heating Curve 
    sltM: 60,       // KVS:SlotMinutes (optional) VC: N/A, price slot length 15, 30, 60, 120, 180 or 240 min; 60 = hourly averages as before v5
    pFac: 0.5,      // Power factor
    mnKv: false,    // Forcing script to KVS mode (true) or Virtual components mode (false)
}
/****** PROGRAM INITIAL SETTINGS ******/

let s = {
    exSc: [],       // KVS:ExistingSchedule Existing heating schedule IDs
    vers: 0,        // KVS:Version
}

/*
Heating hours a day from the forecast (PowerFactor 0.5): (16 - T) * 0.5 + HeatingCurve - 2, none above 16 °C,
at most the period; a period gets its share of the day, rounded down to whole slots. T is the "feels like" average.

    |   ------   24h heating curve (hours per period)   ------   |
°C  |-10 -8  -6  -4  -2  0   2   4   6   8   10  
_________________________________________________
17  |0   0   0   0   0   0   0   0   0   0   0   
15  |0   0   0   0   0   0   0   2   4   6   8   
10  |0   0   0   0   0   1   3   5   7   9   11  
5   |0   0   0   0   1   3   5   7   9   11  13  
0   |0   0   0   2   4   6   8   10  12  14  16  
-5  |0   0   2   4   6   8   10  12  14  16  18  
-10 |1   3   5   7   9   11  13  15  17  19  21  
-15 |3   5   7   9   11  13  15  17  19  21  23  
-20 |6   8   10  12  14  16  18  20  22  24  24  
-25 |8   10  12  14  16  18  20  22  24  24  24  

    |   ------   12h heating curve (hours per period)   ------   |
°C  |-10 -8  -6  -4  -2  0   2   4   6   8   10  
_________________________________________________
17  |0   0   0   0   0   0   0   0   0   0   0   
15  |0   0   0   0   0   0   0   1   2   3   4   
10  |0   0   0   0   0   0   1   2   3   4   5   
5   |0   0   0   0   0   1   2   3   4   5   6   
0   |0   0   0   1   2   3   4   5   6   7   8   
-5  |0   0   1   2   3   4   5   6   7   8   9   
-10 |0   1   2   3   4   5   6   7   8   9   10  
-15 |1   2   3   4   5   6   7   8   9   10  11  
-20 |3   4   5   6   7   8   9   10  11  12  12  
-25 |4   5   6   7   8   9   10  11  12  12  12  

Forecast temp °C is "feels like": more information here: https://en.wikipedia.org/wiki/Apparent_temperature
*/

let _ = {
    hTim: 0,       //heating time
    cPer: 0,       //number of periods
    tsPr: 0,        //time of the last price calculation (epoch)
    tsFc: 0,        //time of the last forecast (epoch)
    freq: 300,      //frequency of script execution in seconds (5 min)
    isLp: false,    //loop flag
    updD: 46 + Math.floor(Math.random() * 10),      //minute of the calculation hour for server requests (46-55): after the hh:45 slot has started, before the next period
    prt: 6 * 60 * 60,  //Elering request length (s), short parts keep the response small
    dSt: 0,         //start of the price day (epoch)
    dEn: 0,         //end of the price day (epoch)
    prc: null,      //prices of the day per slot in cents with the transfer fee
    fsl: null,      //transfer fee of each slot in cents, read together with the prices
    qSec: 900,      //one Elering price row is a quarter-hour
    eNf: -105,      //Shelly RPC error: not found
    vcMx: 5,        //virtual component RPC calls in flight at most
    dSlt: 60,       //default slot length (min): hourly planning as before v5
    sl: 3600,       //slot length (s), from SlotMinutes
    nRw: 0,         //quarter-hour rows read from Elering for the day
    acc: 0,         //spot price sum of the slot being read
    fAc: 0,         //network fee sum of the slot being read
    smr: false,     //device clock is on summer time (Imatra tariff)
    sId: Shelly.getCurrentScriptId(),               //script ID
    pId: "Id" + Shelly.getCurrentScriptId() + ": ", //print ID
    scId: [],       //IDs of the created schedules
    manu: false,    //manual heating flag
    prov: "None",   //network provider name
    fee: null,      //transfer fees of the network package
    newV: 5.0,      //new script version
    sdOk: false,    //system data OK
    cfR: null,      //ConfigurationData as stored in KVS, to skip rewriting an unchanged value
    cfKp: false,    //keep the stored ConfigurationData: it could not be read or is not valid JSON
    sdNf: false,    //SystemData is not in KVS (first install)
    sdBad: false,   //SystemData in KVS is not valid JSON, rewritten at the end of the cycle
    tCal: 0,        //time of the calculation (epoch), taken once per cycle
    nFl: 0,         //schedules that could not be created in this cycle
    vcBad: false,   //Virtual Components could not be read in this cycle
    hMin: 60,       //minutes in an hour
    eest: 3 * 3600, //Estonian summer time offset (s)
    txt: "",        //heating slots to print
};
let cntr = 0;    //counter for async functions

function dtVc() {
    return [
        {
            type: "group", id: 200, config: {
                name: "Smart Heating"
            }
        },
        {
            type: "enum", id: 200, config: {
                name: "Heating Period (h)",
                options: ["24", "12", "6", "0"],
                default_value: "24",
                persisted: true,
                meta: { ui: { view: "dropdown", webIcon: 13, titles: { "24": "24 hour", "12": "12 hour", "6": "6 hour", "0": "No period" } } }
            }
        },
        {
            type: "number", id: 200, config: {
                name: "Heating Time (h/period)",
                default_value: 10,
                min: 0,
                max: 24,
                persisted: true,
                meta: { ui: { view: "slider", unit: "h/period" } }
            }
        },
        {
            type: "enum", id: 201, config: {
                name: "Network Package",
                options: ["NONE", "VORK1", "VORK2", "VORK4", "VORK5", "PARTN24", "PARTN24PL", "PARTN12", "PARTN12PL", "PAMATA1", "SPECIAL1"],
                default_value: "VORK2",
                persisted: true,
                meta: { ui: { view: "dropdown", webIcon: 22, titles: { "NONE": "No package", "VORK1": "Võrk1 Base", "VORK2": "Võrk2 DayNight", "VORK4": "Võrk4 DayNight", "VORK5": "Võrk5 DayNightPeak", "PARTN24": "Partner24 Base", "PARTN24PL": "Partner24Plus Base", "PARTN12": "Partner12 DayNight", "PARTN12PL": "Partner12Plus DayNight", "PAMATA1": "Pamata-1", "SPECIAL1": "Speciālais 1" } } }
            }
        },
        {
            type: "number", id: 201, config: {
                name: "Heat On (min price)",
                default_value: 1,
                min: 0,
                max: 100,
                persisted: true,
                meta: { ui: { view: "slider", unit: "€/MWh or less" } }
            }
        },
        {
            type: "number", id: 202, config: {
                name: "Heat Off (max price)",
                default_value: 300,
                min: 0,
                max: 500,
                persisted: true,
                meta: { ui: { view: "slider", unit: "€/MWh or more" } }
            }
        },
        {
            type: "boolean", id: 201, config: {
                name: "Inverted Relay",
                default_value: false,
                persisted: true,
                meta: { ui: { view: "toggle", webIcon: 7, titles: ["No", "Yes"] } }
            }
        },
        {
            type: "enum", id: 202, config: {
                name: "Market Price Country",
                options: ["ee", "fi", "lv", "lt"],
                default_value: "ee",
                persisted: true,
                meta: { ui: { view: "dropdown", webIcon: 9, titles: { "ee": "Estonia", "fi": "Finland", "lv": "Latvia", "lt": "Lithuania" } } }
            }
        },
        {
            type: "boolean", id: 200, config: {
                name: "Forecast Heat",
                default_value: false,
                persisted: true,
                meta: { ui: { view: "toggle", webIcon: 14, titles: ["No", "Yes"] } }
            }
        },
        {
            type: "number", id: 203, config: {
                name: "Forecast Impact +/-",
                default_value: 0,
                min: -4,
                max: 8,
                persisted: true,
                meta: { ui: { view: "slider", unit: "h more heat" } }
            }
        },
    ];
}

function strt() {
    sAut();
    gKvs();
}
/* set the script to start automatically on boot */
function sAut() {
    if (!Shelly.getComponentConfig("script", _.sId).enable) {
        Shelly.call('Script.SetConfig', { id: _.sId, config: { enable: true } },
            function (res, err, msg) {
                if (err != 0) {
                    print(_.pId, "Heating script autostart is not enabled.", msg);
                }
            });
    }
}

// check if Shelly supports Virtual components
function isVC() {
    if (c.mnKv === true) {
        print(_.pId, "ManualKVS=true → forcing KVS mode");
        return false;
    }
    const info = Shelly.getDeviceInfo();
    // Gen3 and Gen4 always; Gen2 only Pro with firmware newer than 1.4.3
    const gen2ok = (info.gen === 2 && (info.app || "").substring(0, 3) === "Pro" && verC('1.4.3', info.ver));
    return (info.gen === 4 || info.gen === 3 || gen2ok);
}
// compare Shelly FW versions
function verC(old, newV) {
    const oldP = old.split('.');
    const newP = newV.split('.');
    for (var i = 0; i < newP.length; i++) {
        let a = ~~newP[i]; // parse int
        let b = ~~oldP[i]; // parse int
        if (a > b) return true;
        if (a < b) return false;
    }
    return false;
}
// Get KVS ConfigurationData into memory
function memC(dt) {
    c.tPer = val(dt.TimePeriod, c.tPer);
    c.hTim = val(dt.HeatingTime, c.hTim);
    c.isFc = val(dt.IsForecastUsed, c.isFc);
    c.pack = val(dt.EnergyProvider, c.pack);
    c.lowR = val(dt.AlwaysOnPrice, c.lowR);
    c.higR = val(dt.AlwaysOffPrice, c.higR);
    c.fulR = typeof dt.MaxFullPrice === "number" && dt.MaxFullPrice > 0 ? dt.MaxFullPrice : 0;
    if (dt.MaxFullPrice !== undefined && c.fulR !== dt.MaxFullPrice) {
        print(_.pId, "MaxFullPrice", dt.MaxFullPrice, "is not a number above 0, the full price limit is off.");
    }
    c.sltM = val(dt.SlotMinutes, _.dSlt);
    c.Inv = val(dt.InvertedRelay, c.Inv);
    c.rId = val(dt.RelayId, c.rId);
    c.cnty = val(dt.Country, c.cnty);
    c.hCur = val(dt.HeatingCurve, c.hCur);
    c.mnKv = typeof dt.ManualKVS === "boolean" ? dt.ManualKVS : c.mnKv;
}
// Whole slots in the given hours; a dropped remainder is logged because it shortens the heating
function slts(hours) {
    const n = Math.floor(hours * 3600 / _.sl);
    if (n * _.sl < hours * 3600) {
        print(_.pId, "Heating time", hours, "h is rounded down to", n, "slots of", c.sltM, "min");
    }
    return n;
}
// A stored value, or the current one when the key is missing
function val(stored, current) {
    return stored === undefined ? current : stored;
}
// Supported slot lengths divide the day and the heating period into whole slots
function isSlt(m) {
    return (m === 15 || m === 30 || m === 60 || m === 120 || m === 180 || m === 240) && (c.tPer <= 0 || (c.tPer * 60) % m === 0);
}
// Check SlotMinutes against the final TimePeriod (KVS or Virtual Components), fall back to hourly slots
function chkS() {
    if (!isSlt(c.sltM)) {
        print(_.pId, "SlotMinutes", c.sltM, "must be 15, 30, 60, 120, 180 or 240 and divide TimePeriod", c.tPer, "h, using", _.dSlt);
        c.sltM = _.dSlt;
    }
    _.sl = c.sltM * 60;
}
// Check EnergyProvider against the package table, fall back to no network fee
function chkP() {
    _.fee = pack()[c.pack];
    if (!_.fee) {
        print(_.pId, "EnergyProvider", c.pack, "is unknown, planning without a network fee (NONE)");
        c.pack = "NONE";
        _.fee = pack().NONE;
    }
    _.prov = _.fee.p;
}
// ConfigurationData data to KVS store
function kvsC() {
    let cdat = {};
    cdat.TimePeriod = c.tPer;
    cdat.HeatingTime = c.hTim;
    cdat.IsForecastUsed = c.isFc;
    cdat.EnergyProvider = c.pack;
    cdat.AlwaysOnPrice = c.lowR;
    cdat.AlwaysOffPrice = c.higR;
    cdat.Country = c.cnty;
    // a key at its default value is left out: KVS holds 253 bytes with every quote escaped, a full configuration does not fit
    if (c.fulR > 0) cdat.MaxFullPrice = c.fulR;
    if (c.sltM !== _.dSlt && isSlt(c.sltM)) cdat.SlotMinutes = c.sltM;
    if (c.Inv) cdat.InvertedRelay = true;
    if (c.rId !== 0) cdat.RelayId = c.rId;
    if (c.hCur !== 0) cdat.HeatingCurve = c.hCur;
    if (c.mnKv) cdat.ManualKVS = true;
    return cdat;
}
// Get KVS SystemData into memory
function memS(dt) {
    s.exSc = dt.ExistingSchedule || [];
    if (typeof s.exSc === "number") {  //v4.9 and older stored one schedule ID
        print(_.pId, "SystemData from v", dt.Version, " migrated to a list of schedules");
        s.exSc = s.exSc > 0 ? [s.exSc] : [];
    }
    s.vers = dt.Version;
}
// Get KVS ConfigurationData and SystemData
function gKvs() {
    cntr += 2;
    _.cfR = null;
    _.cfKp = false;
    _.sdOk = false;
    _.sdNf = false;
    _.sdBad = false;
    Shelly.call('KVS.Get', { key: "SmartHeatingConf" + _.sId },
        function (res, err, msg) {
            cntr--;
            if (err !== 0) {
                if (err !== _.eNf) {
                    _.cfKp = true;
                    print(_.pId, "ConfigurationData not read from KVS, the stored value is kept:", err, msg);
                }
                return;
            }
            try {
                memC(JSON.parse(res.value));
                _.cfR = res.value;
            } catch (e) {
                _.cfKp = true;
                print(_.pId, "ConfigurationData in KVS is not valid JSON, fix it in KVS; default settings are used:", e);
            }
        });

    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + _.sId },
        function (res, err, msg) {
            cntr--;
            if (err !== 0) {
                _.sdNf = err === _.eNf;
                if (!_.sdNf) {
                    print(_.pId, "SystemData not read from KVS:", err, msg);
                }
                return;
            }
            try {
                memS(JSON.parse(res.value));
                _.sdOk = true;
            } catch (e) {
                _.sdBad = true;
                print(_.pId, "SystemData in KVS is not valid JSON, the existing schedules are not deleted:", e);
            }
        });
    wait(inst);
}

// Select running mode like KVS or Virtual components
function inst() {
    if (!_.sdOk && !_.sdNf && !_.sdBad) {
        print(_.pId, "SystemData could not be read, the schedules are kept; next try in", _.freq / 60, "min");
        done();
        return;
    }
    if (isVC()) {
        if ((_.sdOk && !(s.vers < 4.2)) || _.sdBad) {
            print(_.pId, "Existing Virtual Component mode");
            rVc();
        } else {
            print(_.pId, "New Virtual Component installation");
            gVc();
        }
    } else {
        print(_.pId, "Script in KVS mode");
        tKvs();
    }
}

// Store configuration data to KVS
function tKvs() {
    const conf = JSON.stringify(kvsC());
    if (!_.cfKp && conf !== _.cfR) {
        cntr++;
        Shelly.call("KVS.set", { key: "SmartHeatingConf" + _.sId, value: conf },
            function (res, err, msg) {
                if (err !== 0) {
                    print(_.pId, "Configuration not stored in KVS:", err, msg);
                } else {
                    print(_.pId, "Configuration settings stored in KVS");
                }
                cntr--;
            }
        );
    }
    wait(main);
}

// Get all virtual components and delete them all before new installation
function gVc() {
    Shelly.call("Shelly.GetComponents", { dynamic_only: true }, function (res, err, msg) {
        if (err !== 0) {
            print(_.pId, "Failed to get virtual components, the installation is retried in", _.freq / 60, "min:", msg);
            done();
            return;
        }
        dVc(ownC(res.components));
    });
}

// The keys of this script's virtual components, the group first (dtVc order)
function vcKy() {
    return ["group:200", "enum:200", "number:200", "boolean:200", "number:203", "enum:201", "number:201", "number:202", "boolean:201", "enum:202"];
}

// The device's components that this script defines, the other scripts' components are left alone
function ownC(comps) {
    const own = [];
    const mine = vcKy();
    for (let i = 0; comps && i < comps.length; i++) {
        if (mine.indexOf(comps[i].key) >= 0) {
            own.push({ key: comps[i].key });
        }
    }
    return own;
}

// Delete this script's old virtual components one at a time, then add the new ones
function dVc(vCom) {
    vcSt(vCom, "Virtual.Delete", dVc, aVcN);
}

// Start adding the components, built only now
function aVcN() {
    aVc(dtVc());
}

// Add the new virtual components one at a time, then set the group
function aVc(vCom) {
    vcSt(vCom, "Virtual.Add", aVc, sGrp);
}

// One virtual component RPC per second within the call limit; again() continues the list, next runs when it is empty
function vcSt(vCom, mth, again, next) {
    if (cntr < _.vcMx && vCom.length > 0) {
        const comp = vCom.splice(0, 1)[0];
        cntr++;
        Shelly.call(mth, mth === "Virtual.Delete" ? { key: comp.key } : { type: comp.type, id: comp.id, config: comp.config },
            function (res, err, msg) {
                if (err !== 0) {
                    print(_.pId, mth, "failed:", msg);
                }
                cntr--;
            }
        );
    }
    if (vCom.length > 0) {
        Timer.set(1000, false, again, vCom);
    } else {
        wait(next);
    }
}

// Add virtual components to group
function sGrp() {
    const gCnf = { id: 200, value: vcKy().slice(1) };
    Shelly.call("Group.Set", gCnf, function (res, err, msg) {
        if (err !== 0) {
            print(_.pId, "Group config is not set: " + msg);
        }
    });
    rVc();
}

// Read all virtual components and store the values to memory
function rVc() {
    cntr++;
    let mpVC = [
        ["tPer", "enum:200"],
        ["hTim", "number:200"],
        ["isFc", "boolean:200"],
        ["pack", "enum:201"],
        ["lowR", "number:201"],
        ["higR", "number:202"],
        ["Inv", "boolean:201"],
        ["cnty", "enum:202"],
        ["hCur", "number:203"],
    ];
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["status"] },
        function (res, err, msg) {
            if (err !== 0) {
                print(_.pId, "Virtual components not read:", err, msg);
                _.vcBad = true;
            } else {
                let comp = res.components;
                res = null;
                if (comp && comp.length > 0) {
                    for (let i = 0; i < mpVC.length; i++) {
                        for (let j = 0; j < comp.length; j++) {
                            if (mpVC[i][1] === comp[j].key) {
                                const v = comp[j].status.value;
                                c[mpVC[i][0]] = mpVC[i][1] === "enum:200" ? Number(v) : v;   //the period enum is a string
                                break;
                            }
                        }
                    }
                }
            }
            cntr--;
        });
    wait(main);
}

// Main script where all the logic starts.
function main() {
    if (_.vcBad) {
        _.vcBad = false;
        print(_.pId, "Virtual components not read, the schedules are kept; next try in", _.freq / 60, "min");
        done();
        return;
    }
    chkS();
    chkP();
    _.cPer = c.tPer <= 0 ? 0 : Math.ceil(24 / c.tPer);                  //number of periods in a day
    _.hTim = slts(c.hTim > c.tPer ? c.tPer : c.hTim);                    //whole heating slots per period, at most the period
    print(_.pId, "Network provider: ", _.prov, c.pack);

    if (isFcU()) {
        gFcs();
    } else {
        gEle();
    }
}

// The weather forecast decides the heating time: only with heating periods
function isFcU() {
    return c.isFc && c.tPer > 0;
}

// The calculation cycle is over: release the cycle's data, the loop may start the next one
function done() {
    _.prc = null;
    _.fsl = null;
    _.cfR = null;
    _.isLp = false;
}

// Get Open-Meteo min and max "feels like" temperatures
function gFcs() {
    const loc = Shelly.getComponentConfig("sys").location;
    const lat = JSON.stringify(loc.lat);
    const lon = JSON.stringify(loc.lon);
    let url = "https://api.open-meteo.com/v1/forecast?hourly=apparent_temperature&timezone=auto&forecast_days=1&forecast_hours=";
    url = url + c.tPer + "&latitude=" + lat + "&longitude=" + lon;
    print(_.pId, "Forecast query: ", url);
    Shelly.call("HTTP.GET", { url: url, timeout: 5, ssl_ca: "*" }, function (res, err) {
        url = null;
        if (err != 0 || res === null || res.code != 200) {
            hErr("Get forecast HTTP.GET error, check again in " + _.freq / 60 + " min.");
            return;
        }
        //open-meteo json response to get 6h, 12h or 24h temperatures
        let temp = null;
        try {
            temp = JSON.parse(res.body).hourly.apparent_temperature;
        } catch (e) {
            temp = null;
        }
        res = null;
        if (!isTmp(temp)) {
            hErr("Forecast answer has no " + c.tPer + " temperatures, check again in " + _.freq / 60 + " min.");
            return;
        }
        let sumT = 0;
        for (let i = 0; i < temp.length; i++) {
            sumT += temp[i];
        }
        const tFcs = Math.ceil(sumT / temp.length);   //AVG and round temperature up
        _.tsFc = Math.floor(Date.now() / 1000.0);   //store the timestamp into memory
        print(_.pId, "We got weather forecast from Open Meteo at ", new Date().toString());

        const maxT = 16;                            //max temperature for the forecast
        let fcH = ((maxT - tFcs) * (c.pFac - 1) + (maxT - tFcs + c.hCur - 2));   //heating hours a day from the forecast, one hour per HeatingCurve step
        fcH = fcH < 0 || tFcs > maxT ? 0 : fcH;     //heating time can't be negative
        const perS = c.tPer * 3600 / _.sl;          //slots in a period (whole, isSlt checked)
        _.hTim = slts(fcH / _.cPer);                //heating slots per period (round-down heating time)
        if (_.hTim > perS) {
            _.hTim = perS;
        }
        print(_.pId, "Temperature forecast with windchill is ", tFcs, " °C, and heating enabled for ", _.hTim * _.sl / 3600, " hours.");
        gEle();
    });
}
// The forecast answer holds one number per hour of the period
function isTmp(temp) {
    if (typeof temp !== "object" || temp === null || temp.length !== c.tPer) {
        return false;
    }
    for (let i = 0; i < temp.length; i++) {
        if (typeof temp[i] !== "number") {
            return false;
        }
    }
    return true;
}

// Get electricity market prices of a day from Elering in parts
function gEle() {
    const epch = Shelly.getComponentStatus("sys").unixtime;
    _.tCal = epch;
    const dt = new Date(epch * 1000);
    // Tomorrow's prices once the day's last slot has started (23:00 for slots of an hour or longer, else the hour's last slot), today's before that
    const day = dt.getHours() === 23 && isLst(dt) ? epch + 2 * 60 * 60 : epch;
    _.dSt = mid(day);
    _.dEn = mid(_.dSt + 27 * 60 * 60);  //27 h later is the next day also on DST days (23 h or 25 h)
    _.smr = gTz(dt) === _.eest;
    _.prc = [];
    _.fsl = [];
    _.nRw = 0;
    _.acc = 0;
    _.fAc = 0;
    gPrt(_.dSt);
}

// The hour's last slot has started at this time (any minute for slots of an hour or longer)
function isLst(dt) {
    return dt.getMinutes() >= _.hMin - (c.sltM < _.hMin ? c.sltM : _.hMin);
}

// Local midnight before the epoch, corrected by the hour when DST changed in between
function mid(epch) {
    const dt = new Date(epch * 1000);
    const mn = epch - dt.getHours() * 3600 - dt.getMinutes() * 60 - dt.getSeconds();
    const hr = new Date(mn * 1000).getHours();
    return hr === 23 ? mn + 3600 : hr === 1 ? mn - 3600 : mn;
}

// Get the prices from st to the next part and continue with the next part or the plan
function gPrt(st) {
    const en = st + _.prt < _.dEn ? st + _.prt : _.dEn;
    let url = "https://dashboard.elering.ee/api/nps/price/csv?fields=" + c.cnty;
    url += "&start=" + new Date(st * 1000).toISOString() + "&end=" + new Date(en * 1000).toISOString();
    print(_.pId, "Elering query: ", url);

    Shelly.call("HTTP.GET", { url: url, timeout: 5, ssl_ca: "*" }, function (res, err) {
        url = null;
        if (err != 0 || res === null || res.code != 200 || !res.body_b64) {
            hErr("Elering HTTP.GET error, check again in " + _.freq / 60 + " min.");
            return;
        }
        let body = atob(res.body_b64);  //decode base64 to text
        res = null;
        pCsv(body, en);
        body = null;
        //if elering API returns less than one price per 15 min, the script will try to download the data again after set of minutes
        if (_.nRw !== (en - _.dSt) / _.qSec) {
            hErr("Elering API didn't return prices, check again in " + _.freq / 60 + " min.");
            return;
        }
        if (en < _.dEn) {
            gPrt(en);
            return;
        }
        plan();
    });
}

// Add the CSV rows "epoch";"local time";"price" before en to the prices, stop at a missing, extra or
// unreadable row. A slot (pSlt) is the average spot price plus the average network fee of its
// quarter-hours; an incomplete last slot of a DST day is not closed, its timer would run past midnight.
function pCsv(body, en) {
    const n = _.sl / _.qSec;            //quarter-hours in one slot
    let pos = body.indexOf("\n");      //skip the header
    while (pos >= 0) {
        let aPos = body.indexOf("\"", pos) + 1;
        if (aPos === 0) {
            break; // EOF
        }
        let ts = Number(body.substring(aPos, body.indexOf("\"", aPos)));
        if (ts >= en || ts !== _.dSt + _.nRw * _.qSec) {
            break; // next part or unexpected row
        }
        aPos = body.indexOf(";\"", aPos) + 2; //skip ;
        aPos = body.indexOf(";\"", aPos) + 2; //find price
        const raw = body.substring(aPos, body.indexOf("\"", aPos)).replace(",", ".");
        const pric = Number(raw);
        if (raw === "" || pric !== pric) {
            break; // unreadable price, the row count check sends the cycle to the fallback
        }
        _.acc += pric;
        _.fAc += fFee(ts);
        _.nRw++;
        if (_.nRw % n === 0) {
            pSlt(n);
        }
        pos = body.indexOf("\n", aPos);       //next line
    }
}

// Close the slot of the last n rows read: average spot price plus average network fee, the fee kept for the plan
function pSlt(n) {
    const fee = Math.round(_.fAc * 100 / n);
    _.fsl.push(fee);
    _.prc.push(Math.round(_.acc * 100 / n) + fee);
    _.acc = 0;
    _.fAc = 0;
}

// Choose the heating slots of the day and create the schedules
function plan() {
    //store the timestamp into memory
    _.tsPr = _.tCal;
    print(_.pId, "We got market prices from Elering ", new Date().toString());
    print(_.pId, "Heating will be turned on to following slots 'HH:mm (EUR/MWh Energy Price + Transmission)':");
    let sel = nSel();
    const tx = fullTax();
    const low = c.lowR * 100;
    const high = c.higR * 100;
    const now = new Date(_.tCal * 1000);
    const numP = isLst(now) ? Math.ceil((now.getHours() % 23 + 2) / c.tPer)   //the next period once the hour's last slot has started
        : Math.floor(now.getHours() / c.tPer) + 1;                             //the current period after a restart before that
    let cnt = 0;
    let a = 0;
    // The slot loop stays inline: the device's interpreter overflows its stack at about five nested calls
    for (let i = 0; i < (c.tPer <= 0 ? 1 : _.cPer); i++) {                 //every period, or the whole day without periods
        const b = c.tPer <= 0 ? _.prc.length : pEnd(a, (i + 1) * c.tPer);  //first slot after the period
        const t = c.tPer <= 0 ? -1 : nth(a, b, _.hTim < b - a ? _.hTim : b - a);  //last cheap slot; a DST day has fewer slots than a period
        const pt = t < 0 ? 0 : _.prc[t];
        if (c.tPer <= 0 || !isFcU() || (i + 1) == numP) {                  //with the forecast only the chosen period
            for (let j = a; j < b; j++) {
                const p = _.prc[j];
                const net = p - _.fsl[j];
                const cheap = (t >= 0 && (p < pt || p === pt && j <= t)) || net < low;
                const dear = net > high || (tx !== null && Math.round((p + tx.add) * tx.fac) > tx.lim);
                if (cheap && !dear) {
                    mark(sel, j);
                    cnt++;
                }
            }
        }
        a = b;
    }
    if (!cnt) {
        print(_.pId, "No slot is planned: heating time", _.hTim * _.sl / 3600, "h, or no slot passes the price limits (AlwaysOnPrice, AlwaysOffPrice, MaxFullPrice).");
    }
    prTx();
    _.manu = false;
    _.prc = null;
    _.fsl = null;
    _.scId = [];
    _.nFl = 0;
    fTmr(sel);
}

// Transfer fee in cents of slot j

// First slot from a with local hour hr or later, the number of slots if none
function pEnd(a, hr) {
    while (a < _.prc.length && new Date((_.dSt + a * _.sl) * 1000).getHours() < hr) {
        a++;
    }
    return a;
}

// The n-th cheapest slot from a to b (excluded), -1 if n is 0: repeated extreme search from the nearer
// end of the price order, so at most (b - a) / 2 + 1 passes over the slots
function nth(a, b, n) {
    const len = b - a;
    const up = n * 2 <= len;
    let t = -1;
    for (let k = up ? n : len - n + 1; k > 0; k--) {
        t = next(a, b, t, up);
    }
    return t;
}

// The slot after t in the price order (cheapest first, equal prices by index): the cheapest slot
// above t when up, else the most expensive slot below t; t = -1 starts from the end
function next(a, b, t, up) {
    const pr = _.prc;
    const pt = t < 0 ? 0 : pr[t];
    let m = -1;
    let pm = 0;
    for (let j = a; j < b; j++) {
        const p = pr[j];
        if (t >= 0 && (up ? p < pt || p === pt && j <= t : p > pt || p === pt && j >= t)) {
            continue;
        }
        if (m < 0 || (up ? p < pm : p >= pm)) {
            m = j;
            pm = p;
        }
    }
    return m;
}

// Heating slots as 24 hours of 4 bits, bit q is the quarter starting at q*15 min
function nSel() {
    let sel = [];
    for (let h = 0; h < 24; h++) {
        sel.push(0);
    }
    return sel;
}

// The MaxFullPrice comparison {add, fac, lim} in the units of _.prc, null when the limit is off
function fullTax() {
    if (c.fulR <= 0) return null;
    const tx = tax()[c.cnty];
    if (!tx) {
        print(_.pId, "MaxFullPrice is ignored: charges and VAT are not known for country", c.cnty);
        return null;
    }
    return { add: tx.fix * 100, fac: 1 + tx.vat, lim: c.fulR * 100 };
}

// Mark slot j for heating and print the slots in short lines
function mark(sel, j) {
    const dt = new Date((_.dSt + j * _.sl) * 1000);
    const hr = dt.getHours();
    const mn = dt.getMinutes();
    sel[hr] |= 1 << (mn / 15);
    _.txt += (hr < 10 ? "0" : "") + hr + (mn ? ":" : ":0") + mn + " (" + _.prc[j] / 100 + "), ";
    if (_.txt.length > 100) {
        prTx();
    }
}

// Print the heating slots not printed yet
function prTx() {
    if (_.txt.length > 0) {
        print(_.txt);
        _.txt = "";
    }
}

// Shelly timezone offset in seconds at the given time
function gTz(shDt) {
    const shHr = shDt.getHours();
    const utcH = shDt.toISOString().slice(11, 13);  //UTC hour
    let tz = shHr - utcH;                           //timezone offset
    if (tz > 12) { tz -= 24; }
    if (tz < -12) { tz += 24; }
    return tz * 60 * 60;
}

// Calculate transfer fee based on the timestamp.
function fFee(epoch) {
    const dt = new Date(epoch * 1000);
    const hour = dt.getHours();
    const day = dt.getDay();
    const mnth = dt.getMonth();
    if (_.prov === "Elektrilevi") {
        if ((mnth >= 10 || mnth <= 2) && (day === 0 || day === 6) && hour >= 16 && hour < 20) {
            // peak holiday: Nov-Mar, SA-SU at 16:00–20:00
            return _.fee.hMRt;
        } else if ((mnth >= 10 || mnth <= 2) && day > 0 && day < 6 && ((hour >= 9 && hour < 12) || (hour >= 16 && hour < 20))) {
            // peak daytime: Nov-Mar: MO-FR at 09:00–12:00 and at 16:00–20:00
            return _.fee.dMRt;
        } else if (hour < 7 || hour >= 22 || day === 6 || day === 0) {
            //night-time: MO-FR at 22:00–07:00, SA-SU all day
            return _.fee.nRt;
        } else {
            //daytime: MO-FR at 07:00–22:00
            return _.fee.dRt;
        }
    } else if (_.prov === "Imatra") {
        if (_.smr) {
            if (hour < 8 || day === 6 || day === 0) {
                //summer-night-time: MO-FR at 00:00–08:00, SA-SU all day
                return _.fee.nRt;
            } else {
                //daytime: MO-FR at 08:00–24:00
                return _.fee.dRt;
            }
        } else {
            if (hour < 7 || hour >= 23 || day === 6 || day === 0) {
                //winter-night-time: MO-FR at 23:00–07:00, SA-SU all day
                return _.fee.nRt;
            } else {
                //daytime: MO-FR at 07:00–23:00
                return _.fee.dRt;
            }
        }
    } else if (_.prov === "Lv") {
        return _.fee.dRt;
    } else {
        return 0;
    }
}

// Set countdown timer to flip Shelly status
function fTmr(sel) {
    const timr = _.sl + 10; //+10sec to remove flap between continous heating slots
    Shelly.call("Switch.SetConfig", {
        id: c.rId,
        config: {
            auto_on: c.Inv,
            auto_on_delay: timr,
            auto_off: !c.Inv,
            auto_off_delay: timr
        }
    }, function (res, err, msg) {
        if (err !== 0) {
            print(_.pId, "Relay timer not set, the relay would not switch off after a slot:", err, msg);
        }
        fdSc(sel);  //delete the existing schedules and create the new ones
    });
}
// Delete the existing schedules one at a time, then create the new schedules
function fdSc(sel) {
    if (s.exSc.length === 0) {
        fScd(sel, 0);
        return;
    }
    const id = s.exSc.pop();
    Shelly.call("Schedule.Delete", { id: id }, function (res, err, msg) {
        if (err === 0 || err === _.eNf) {
            fdSc(sel);
            return;
        }
        print(_.pId, "Schedule", id, "not deleted, kept for the next calculation:", err, msg);
        _.scId.push(id);
        Shelly.call("Schedule.Update", { id: id, enable: false }, function (r, e, m) {
            if (e !== 0) {
                print(_.pId, "Schedule", id, "not disabled either, it keeps switching the relay:", e, m);
            }
            fdSc(sel);
        });
    });
}

// Create one schedule for the quarter q (minute q*15) of all heating hours, then for the next quarter
function fScd(sel, q) {
    let hArr = [];
    while (q <= 3 && hArr.length === 0) {    //the next quarter with heating hours, without recursing
        for (let h = 0; h < 24; h++) {
            if (sel[h] & (1 << q)) {
                hArr.push(h);
            }
        }
        if (hArr.length === 0) {
            q++;
        }
    }
    if (q > 3) {
        if (_.nFl > 0) {
            print(_.pId, "#", _.nFl, "schedule(s) not created, those slots will not heat; the device holds at most 20 schedules.");
        }
        fKvs();
        return;
    }
    Shelly.call("Schedule.Create", {
        enable: true,
        timespec: "0 " + q * 15 + " " + hArr.join(",") + " * * *",
        calls: [{
            method: "Switch.Set",
            params: {
                id: c.rId,
                on: !c.Inv
            }
        }]
    }, function (res, err, msg) {
        if (err !== 0) {
            _.nFl++;
            print(_.pId, "Schedule for minute", q * 15, "not created:", err, msg);
        } else {
            _.scId.push(res.id); //scheduleID to store in KVS
        }
        fScd(sel, q + 1);
    });
}

// Store the schedulerID, version and last calculation to KVS to have them in case of power outage
function fKvs() {
    s.exSc = _.scId;
    s.vers = _.newV;
    const sdat = { LastCalculation: new Date().toString(), ExistingSchedule: s.exSc, Version: s.vers };
    Shelly.call("KVS.set", { key: "SmartHeatingSys" + _.sId, value: JSON.stringify(sdat) },
        function (res, err, msg) {
            if (err !== 0) {
                print(_.pId, "SystemData not stored in KVS:", err, msg);
            }
            const nxt = nxHr(isLst(new Date()) ? 1 : 0);   //after a restart before the hour's last slot the same hour recalculates
            print(_.pId, "Script v", _.newV, (_.scId.length > 0 ? " schedule IDs:" + _.scId.join(",") : "") + ", next heating calculation at", nxt + ":" + _.updD);
            wait(f_Wd);
        });
}

//if the internet is not working or Elering is down
function fMan() {
    if (_.manu) {
        done();     //the fallback schedule is already on the device
        return;
    }
    _.manu = true;

    let chpH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 18, 19, 20];   //hours from cheap to dear
    const hrs = c.sltM < _.hMin ? 1 : c.sltM / _.hMin;  //hours in one slot
    const inH = c.sltM < _.hMin ? _.hMin / c.sltM : 1;  //slots in one hour
    let sel = nSel();
    for (let i = 0; i < _.cPer; i++) {                  //_.hTim slots per period from its cheapest hours that start a slot
        let k = 0;
        for (let x = 0; x < 24 && k < _.hTim; x++) {
            const h = chpH[x];
            if (h < i * c.tPer || h >= (i + 1) * c.tPer || h % hrs !== 0) {
                continue;
            }
            for (let q = 0; q < inH && k < _.hTim; q++) {
                sel[h] |= 1 << (q * c.sltM / 15);
                k++;
            }
        }
    }
    chpH = null;
    _.scId = [];
    _.nFl = 0;
    fTmr(sel);  //the same three lines as in plan(): a shared function would add a call level
}

// Handle errors by logging and setting manual mode.
function hErr(msg) {
    print(_.pId, "# Planning error, using historical cheap hours because ", msg);
    fMan();
}
// Wait for the RPC calls to be completed before starting next function.
function wait(data) {
    if (cntr !== 0) {
        Timer.set(1000, false, wait, data);
        return;
    }
    if (typeof data === "function") {   //a function, or an array of the function and its parameter; a timer callback starts a fresh call stack
        Timer.set(1, false, data);
    } else {
        Timer.set(1, false, data[0], data[1]);
    }
}

// Next hour for heating calculation
function nxHr(adHr) {
    const chkT = c.isFc && c.tPer > 0 ? c.tPer : 24;   //isFcU() inline, this runs four calls deep
    const hr = (Math.ceil((new Date(Date.now() + (adHr * 60 * 60 * 1000)).getHours() + 1) / chkT) * chkT) - 1;
    return hr > 23 ? 23 : hr;
}

/**
Getting prices or forecast for today if 
    * prices or forecast have never been fetched OR 
    * prices or forecast are not from today or yesterday OR 
    * prices or forecast needs regular update
 */
function updt(ts) {
    const nHr = nxHr(0);                                //next hour for heating calculation
    const now = new Date();                             //now
    const yDt = new Date((mid(Math.floor(now / 1000)) - 1) * 1000);  //the last second of yesterday, on DST days too
    const tDt = new Date(ts * 1000);                    //timestamp
    const tTd = tDt.getFullYear() === now.getFullYear() && tDt.getMonth() === now.getMonth() && tDt.getDate() === now.getDate();
    const tYd = tDt.getFullYear() === yDt.getFullYear() && tDt.getMonth() === yDt.getMonth() && tDt.getDate() === yDt.getDate();
    const tAft = tDt.getHours() === nHr && isLst(tDt) && tTd;   //already planned after the hour's last slot
    const isDue = now.getHours() === nHr && now.getMinutes() >= _.updD;
    return (isDue && !tAft) || !(tTd || tYd);
}

// This loop is to update the heating schedule
function loop() {
    if (_.isLp) {
        return;
    }
    _.isLp = true;
    if (updt(_.tsPr) || isFcU() && updt(_.tsFc)) { //check if the prices or forecast needs to be updated
        strt();                                     //start the program
    } else {
        done();
    }
}

let t_hd;           //timer handle
let t_ct = 0;       //seconds waited for the device clock
// Wait for the device clock (SNTP): schedules cannot fire and prices cannot be planned without it
function fcTm() {
    const epch = Shelly.getComponentStatus("sys").unixtime;
    if (epch > 0) {
        Timer.clear(t_hd);
        print(_.pId, "Shelly has time ", new Date(epch * 1000));
        //start the main loop with a random delay (0-4 s) to avoid the same starting time for concurrent instances
        Timer.set(Math.floor(Math.random() * 5) * 1000, false, loop);
        return;
    }
    t_ct++;
    if (t_ct % 30 === 0) {
        print(_.pId, "Shelly has no time after", t_ct, "seconds, waiting for the clock.");
    }
}

/*  ---------  WATCHDOG START  ---------   */
/** find watchdog script ID */
function f_Wd() {
    Shelly.call('Script.List', null, function (res, err, msg) {
        if (err !== 0 || !res) {
            print(_.pId, "Script list not read, the watchdog is checked at the next calculation:", err, msg);
            done();
            return;
        }
        let id = 0;
        const scr = res.scripts;
        res = null;
        for (let i = 0; i < scr.length; i++) {
            if (scr[i].name === "watchdog") {
                id = scr[i].id;
                break;
            }
        }
        /** Create a new script (id==0) or stop the existing script (id<>0) if watchdog found. */
        if (id === 0) {
            Shelly.call('Script.Create', { name: "watchdog" }, putC, { id: id });   //create a new watchdog 
        } else {
            Shelly.call('Script.Stop', { id: id }, putC, { id: id });               //stop the existing watchdog 
        }
    });
}

// Add code to the watchdog
function putC(res, err, msg, data) {
    if (err !== 0) {
        print(_.pId, "Watchdog script not created or stopped:", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
        done();
    } else {
        let code = 'function strt(e){Shelly.call("KVS.Get",{key:"SmartHeatingSys"+e},(function(t){if(t){try{delS(JSON.parse(t.value),e)}catch(l){print("Script #"+e,"SystemData is not valid JSON, schedules are not deleted by watchdog.")}}}))}function delS(e,t){let l="number"==typeof e.ExistingSchedule?e.ExistingSchedule>0?[e.ExistingSchedule]:[]:e.ExistingSchedule||[];0!==l.length&&(e.ExistingSchedule=[],delN(l,e,t))}function delN(e,t,l){if(0===e.length){Shelly.call("KVS.set",{key:"SmartHeatingSys"+l,value:JSON.stringify(t)});return}let d=e.pop();Shelly.call("Schedule.Delete",{id:d},(function(n,i){0!==i&&-105!==i&&t.ExistingSchedule.push(d),print("Script #"+l,"schedule ",d,0===i?" deleted by watchdog.":-105===i?" already gone.":" deletion by watchdog failed."),delN(e,t,l)}))}Shelly.addStatusHandler((function(e){"script"===e.name&&!1===e.delta.running&&strt(e.id)}));'
        const id = res.id > 0 ? res.id : data.id;   //get the script ID
        Shelly.call('Script.PutCode', { id: id, code: code }, function (res, err, msg, data) {
            if (err === 0) {
                a_St(data.id);
            } else {
                print(_.pId, "Code is not added to the script:", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
                done();
            }
        }, { id: id });
    }
}

// Enable autostart for the watchdog
function a_St(sId) {
    if (!Shelly.getComponentConfig("script", sId).enable) {
        Shelly.call('Script.SetConfig', { id: sId, config: { enable: true } }, function (res, err, msg) {
            if (err !== 0) {
                print(_.pId, "Watchdog script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and schedule is not deleted if heating script is stopped or deleted.");
            }
        });
    }
    // Start the watchdog
    Shelly.call('Script.Start', { id: sId }, function (res, err, msg) {
        if (err === 0) {
            print(_.pId, "Watchdog script installed and started.");
            const st = Shelly.getComponentStatus("script", _.sId);
            print(_.pId, "Memory used:", st.mem_used, "peak:", st.mem_peak);

        } else {
            print(_.pId, "Watchdog script is not started.", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
        }
    });
    done();
}
/*  ---------  WATCHDOG END  ---------   */

t_hd = Timer.set(1000, true, fcTm);     //start the Shelly timecheck timer
Timer.set(_.freq * 1000, true, loop);   //start the main loop with a frequency of 5 minutes
