const BasicClient = require("../basic-client");
const Ticker = require("../ticker");
const Trade = require("../trade");
const Level2Point = require("../level2-point");
const Level2Snapshot = require("../level2-snapshot");
const Level2Update = require("../level2-update");
const Level3Point = require("../level3-point");
const Level3Snapshot = require("../level3-snapshot");
const Level3Update = require("../level3-update");

class BitfinexClient extends BasicClient {
  constructor({ wssPath = "wss://api.bitfinex.com/ws/2", watcherMs } = {}) {
    super(wssPath, "Bitfinex", undefined, watcherMs);
    this._channels = {};

    this.hasTickers = true;
    this.hasTrades = true;
    this.hasLevel2Updates = true;
    this.hasLevel3Updates = true;
    this._connect();
    let hasSentConfig = false;
    // immediately send the config event to include sequence IDs in every message
    this._wss.on('open', function open() {
      if (!hasSentConfig) {
        hasSentConfig = true;
        // see docs for "conf" flags. https://docs.bitfinex.com/docs/ws-general#configuration
        // 65536 adds a sequence ID to each message
        this._wss.send(JSON.stringify({ event: 'conf', flags: 65536 }))
      }
    });
  }

  _sendSubTicker(remote_id) {
    this._wss.send(
      JSON.stringify({
        event: "subscribe",
        channel: "ticker",
        pair: remote_id,
      })
    );
  }

  _sendUnsubTicker(remote_id) {
    this._wss.send(
      JSON.stringify({
        event: "unsubscribe",
        channel: "ticker",
        pair: remote_id,
      })
    );
  }

  _sendSubTrades(remote_id) {
    this._wss.send(
      JSON.stringify({
        event: "subscribe",
        channel: "trades",
        pair: remote_id,
      })
    );
  }

  _sendUnsubTrades(remote_id) {
    let chanId = this._findChannel("trades", remote_id);
    this._sendUnsubscribe(chanId);
  }

  _sendSubLevel2Updates(remote_id) {
    setTimeout(() => {
      this._wss.send(
        JSON.stringify({
          event: "subscribe",
          channel: "book",
          pair: remote_id,
          len: "250"
        })
      );
    }, 2000)
  }

  _sendUnsubLevel2Updates(remote_id) {
    let chanId = this._findChannel("level2updates", remote_id);
    this._sendUnsubscribe(chanId);
  }

  _sendSubLevel3Updates(remote_id) {
    this._wss.send(
      JSON.stringify({
        event: "subscribe",
        channel: "book",
        pair: remote_id,
        prec: "R0",
        length: "100",
      })
    );
  }

  _sendUnsubLevel3Updates(remote_id) {
    let chanId = this._findChannel("level3updates", remote_id);
    this._sendUnsubscribe(chanId);
  }

  _sendUnsubscribe(chanId) {
    if (chanId) {
      this._wss.send(
        JSON.stringify({
          event: "unsubscribe",
          chanId: chanId,
        })
      );
    }
  }

  _findChannel(type, remote_id) {
    for (let chan of Object.values(this._channels)) {
      if (chan.pair === remote_id) {
        if (type === "trades" && chan.channel === "trades") return chan.chanId;
        if (type === "level2updates" && chan.channel === "book" && chan.prec !== "R0")
          return chan.chanId;
        if (type === "level3updates" && chan.channel === "book" && chan.prec === "R0")
          return chan.chanId;
      }
    }
  }

  _onMessage(raw) {
    let msg = JSON.parse(raw);
    console.log('got msg', msg);

    // capture channel metadata
    if (msg.event === "subscribed") {
      this._channels[msg.chanId] = msg;
      return;
    }

    // lookup channel
    let channel = this._channels[msg[0]];
    if (!channel) return;

    // ignore heartbeats
    if (msg[1] === "hb") {
      return;
    };

    if (channel.channel === "ticker") {
      let market = this._tickerSubs.get(channel.pair);
      if (!market) return;

      this._onTicker(msg, market);
      return;
    }

    // trades
    if (channel.channel === "trades" && msg[1] === "tu") {
      let market = this._tradeSubs.get(channel.pair);
      if (!market) return;

      this._onTradeMessage(msg, market);
      return;
    }

    // level3
    if (channel.channel === "book" && channel.prec === "R0") {
      let market = this._level3UpdateSubs.get(channel.pair);
      if (!market) return;

      if (Array.isArray(msg[1][0])) this._onLevel3Snapshot(msg, market);
      else this._onLevel3Update(msg, market);
      return;
    }

    // level2
    if (channel.channel === "book") {
      let market = this._level2UpdateSubs.get(channel.pair);
      if (!market) return;
      if (Array.isArray(msg[1][0])) this._onLevel2Snapshot(msg, market);
      else this._onLevel2Update(msg, market);
      return;
    }
  }

  _onTicker(msg, market) {
    let msgBody = msg[1];
    let [bid, bidSize, ask, askSize, change, changePercent, last, volume, high, low] = msgBody;
    let open = last + change;
    let ticker = new Ticker({
      exchange: "Bitfinex",
      base: market.base,
      quote: market.quote,
      timestamp: Date.now(),
      last: last.toFixed(8),
      open: open.toFixed(8),
      high: high.toFixed(8),
      low: low.toFixed(8),
      volume: volume.toFixed(8),
      change: change.toFixed(8),
      changePercent: changePercent.toFixed(2),
      bid: bid.toFixed(8),
      bidVolume: bidSize.toFixed(8),
      ask: ask.toFixed(8),
      askVolume: askSize.toFixed(8),
    });
    this.emit("ticker", ticker, market);
  }

  _onTradeMessage(msg, market) {
    // example msg: [ 359491, 'tu', [ 560287312, 1609712228656, 0.005, 33432 ], 6 ]
    let [id, unix, amount, price] = msg[2];

    let side = amount > 0 ? "buy" : "sell";
    price = price.toFixed(8);
    amount = Math.abs(amount).toFixed(8);
    let trade = new Trade({
      exchange: "Bitfinex",
      base: market.base,
      quote: market.quote,
      tradeId: id.toFixed(),
      unix: unix * 1000,
      side,
      price,
      amount,
    });
    this.emit("trade", trade, market);
  }

  _onLevel2Snapshot(msg, market) {
    let bids = [];
    let asks = [];
    const sequence = +msg[2];
    for (let [price, count, size] of msg[1]) {
      let isBid = size > 0;
      let result = new Level2Point(price.toFixed(8), Math.abs(size).toFixed(8), count.toFixed(0));
      if (isBid) bids.push(result);
      else asks.push(result);
    }
    let result = new Level2Snapshot({
      exchange: "Bitfinex",
      base: market.base,
      quote: market.quote,
      sequenceId: sequence,
      bids,
      asks,
    });
    this.emit("l2snapshot", result, market);
  }

  _onLevel2Update(msg, market) {
    let channel = msg[0];
    let [price, count, size] = msg[1];
    let sequence = +msg[2];

    if (!price.toFixed) return;
    let point = new Level2Point(price.toFixed(8), Math.abs(size).toFixed(8), count.toFixed(0));
    let asks = [];
    let bids = [];

    let isBid = size > 0;
    if (isBid) bids.push(point);
    else asks.push(point);

    let isDelete = count === 0;
    if (isDelete) point.size = (0).toFixed(8); // reset the size to 0, comes in as 1 or -1 to indicate bid/ask
    let update = new Level2Update({
      exchange: "Bitfinex",
      base: market.base,
      quote: market.quote,
      sequenceId: +sequence,
      asks,
      bids,
    });
    this.emit("l2update", update, market);
  }

  _onLevel3Snapshot(msg, market) {
    let bids = [];
    let asks = [];
    
    let channel = msg[0];
    let orders = msg[1];
    let sequence = +msg[2];

    for (let p of orders) {
      let point = new Level3Point(p[0].toFixed(), p[1].toFixed(8), Math.abs(p[2]).toFixed(8));
      if (p[2] > 0) bids.push(point);
      else asks.push(point);
    }
    let result = new Level3Snapshot({
      exchange: "Bitfinex",
      base: market.base,
      quote: market.quote,
      sequenceId: sequence,
      asks,
      bids,
    });
    this.emit("l3snapshot", result, market);
  }

  _onLevel3Update(msg, market) {
    let bids = [];
    let asks = [];
    
    let channel = msg[0];
    // let [price, count, size] = msg[1];
    let [orderId, price, size] = msg[1];
    let sequence = +msg[2];

    let point = new Level3Point(orderId, price.toFixed(8), Math.abs(size).toFixed(8));
    if (size > 0) bids.push(point);
    else asks.push(point);

    let result = new Level3Update({
      exchange: "Bitfinex",
      base: market.base,
      quote: market.quote,
      sequenceId: sequence,
      asks,
      bids,
    });
    this.emit("l3update", result, market);
  }
}

module.exports = BitfinexClient;
