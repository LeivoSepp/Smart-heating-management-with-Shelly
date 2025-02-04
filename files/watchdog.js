//This is a watchdog reference code
let scId = 0;
Shelly.addStatusHandler(function (res) {
    if (res.name === 'script' && !res.delta.running) {
        scId = res.delta.id;
        strt();
    }
});
function strt() {
    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + scId },
        function (res) {
            if (res) {
                delS(JSON.parse(res.value));
            }
        });
}
function delS(sDat) {
    Shelly.call("Schedule.Delete", { id: sDat.ExistingSchedule },
        function (res, err, msg, data) {
            if (err !== 0) { print('Script #' + scId, 'schedule ', data.id, ' deletion by watchdog failed.'); }
            else { print('Script #' + scId, 'schedule ', data.id, ' deleted by watchdog.'); }
        }, { id: sDat.ExistingSchedule }
    );
    updK(sDat);
}
function updK(sDat) {
    sDat.ExistingSchedule = 0;
    Shelly.call("KVS.set", { key: "SmartHeatingSys" + scId, value: JSON.stringify(sDat) },);
}

