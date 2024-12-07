//This is a watchdog reference code
let _ = {
    sId: 0,
    mc: 3,
    ct: 0,
};
Shelly.addStatusHandler(function (status) {
    if (status.name === 'script' && !status.delta.running) {
        _.sId = status.delta.id;
        start(_.sId);
    }
});
function start(sId) {
    Shelly.call('KVS.Get', { key: 'schedulerIDs' + sId }, function (res, err, msg, data) {
        if (res) {
            let v = [];
            v = JSON.parse(res.value);
            res = null;
            delSc(v, data.sId);
        }
    }, { sId: sId });
}
function delSc(si, sId) {
    if (_.ct < 6 - _.mc) {
        for (let i = 0; i < _.mc && i < si.length; i++) {
            let id = si.splice(0, 1)[0];
            _.ct++;
            Shelly.call('Schedule.Delete', { id: id },
                function (res, err, msg, data) {
                    if (err !== 0) { print('Script #' + sId, 'schedule ', data.id, ' del FAIL.'); }
                    else { print('Script #' + sId, 'schedule ', data.id, ' del OK.'); }
                    _.ct--;
                },
                { id: id }
            );
        }
    }
    if (si.length > 0) { Timer.set(1000, false, function () { delSc(si, sId); }); } else {
        delKVS(sId);
    }
}
function delKVS(sId) {
    if (_.ct !== 0) {
        Timer.set(
            1000,
            false,
            function () {
                delKVS(sId);
            });
        return;
    }
    Shelly.call('KVS.Delete', { key: 'schedulerIDs' + sId });
    Shelly.call('KVS.Delete', { key: 'timestamp' + sId });
    print('Heating script #' + sId, 'is clean');
}

