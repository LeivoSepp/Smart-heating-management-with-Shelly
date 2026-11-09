//This is a watchdog reference code
Shelly.addStatusHandler(function (res) {
    if (res.name === 'script' && res.delta.running === false) {
        strt(res.id);
    }
});
function strt(scId) {
    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + scId },
        function (res) {
            if (res) {
                try {
                    delS(JSON.parse(res.value), scId);
                } catch (e) {
                    print('Script #' + scId, 'SystemData is not valid JSON, schedules are not deleted by watchdog.');
                }
            }
        });
}
// ExistingSchedule is a list of schedule IDs since v5.0, before it was one ID
function delS(sDat, scId) {
    const ids = typeof sDat.ExistingSchedule === "number" ? (sDat.ExistingSchedule > 0 ? [sDat.ExistingSchedule] : []) : sDat.ExistingSchedule || [];
    if (ids.length === 0) {
        return;
    }
    sDat.ExistingSchedule = [];
    delN(ids, sDat, scId);
}
// Delete the schedules one at a time to stay within the RPC call limit, then store the IDs that still exist
function delN(ids, sDat, scId) {
    if (ids.length === 0) {
        Shelly.call("KVS.set", { key: "SmartHeatingSys" + scId, value: JSON.stringify(sDat) });
        return;
    }
    const id = ids.pop();
    Shelly.call("Schedule.Delete", { id: id },
        function (res, err) {
            if (err !== 0 && err !== -105) {    //-105: not found, already gone
                sDat.ExistingSchedule.push(id);
            }
            print('Script #' + scId, 'schedule ', id, err === 0 ? ' deleted by watchdog.' : err === -105 ? ' already gone.' : ' deletion by watchdog failed.');
            delN(ids, sDat, scId);
        });
}
