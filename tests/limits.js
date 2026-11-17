'use strict';

const RPC_CALL_LIMIT = 5;
const TIMER_LIMIT = 5;
const SCHEDULE_LIMIT = 20;
const SCHEDULE_CALL_LIMIT = 5;
const VIRTUAL_COMPONENT_LIMIT = 10;
const VIRTUAL_ID_FIRST = 200;
const VIRTUAL_ID_LAST = 299;
const KVS_VALUE_LIMIT = 253;
const KVS_BYTES_PER_QUOTE = 2;
const KVS_KEY_LIMIT = 42;
const KVS_KEY_COUNT_LIMIT = 50;

const ERR_INVALID_ARGUMENT = -103;
const ERR_NOT_FOUND = -105;
const ERR_ASSUMED = -108;

function kvsLength(value) {
    const quoteCount = (value.match(/"/g) || []).length;
    return Buffer.byteLength(value, 'utf8') + quoteCount * (KVS_BYTES_PER_QUOTE - 1);
}

module.exports = {
    RPC_CALL_LIMIT, TIMER_LIMIT, SCHEDULE_LIMIT, SCHEDULE_CALL_LIMIT,
    VIRTUAL_COMPONENT_LIMIT, VIRTUAL_ID_FIRST, VIRTUAL_ID_LAST,
    KVS_VALUE_LIMIT, KVS_BYTES_PER_QUOTE, KVS_KEY_LIMIT, KVS_KEY_COUNT_LIMIT,
    ERR_INVALID_ARGUMENT, ERR_NOT_FOUND, ERR_ASSUMED,
    kvsLength,
};
