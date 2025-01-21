//This is a watchdog reference code
let scId = 0;
Shelly.addStatusHandler(function (status) {
    if (status.name === 'script' && !status.delta.running) {
        scId = status.delta.id;
        start();
    }
});
function start() {
    Shelly.call('KVS.Get', { key: 'schedulerIDs' + scId }, function (res, err, msg, data) {
        if (res) {
            delSc(JSON.parse(res.value));
        }
    });
}
function delSc(id) {
    Shelly.call("Schedule.Delete", { id: id },
        function (res, err, msg, data) {
            if (err !== 0) { print('Script #' + scId, 'schedule ', data.id, ' deletion by watchdog failed.'); }
            else { print('Script #' + scId, 'schedule ', data.id, ' deleted by watchdog.'); }
            delKVS();
        }, { id: id }
    );
}
function delKVS() {
    Shelly.call('KVS.Delete', { key: 'schedulerIDs' + scId });
}

