const async = require('async');
const AccountParser = require('../../utils/accountParser');
const fundAccount = require('./fundAccount');
const Transaction = require('ethereumjs-tx')
const ethUtil = require('ethereumjs-util')

class Provider {
  constructor(options) {
    this.web3 = options.web3;
    this.accountsConfig = options.accountsConfig;
    this.blockchainConfig = options.blockchainConfig;
    this.type = options.type;
    this.web3Endpoint = options.web3Endpoint;
    this.logger = options.logger;
    this.isDev = options.isDev;
    this.nonceCache = {}

    this.transactionCountQueue = async.queue(({address}, callback) => {
      return this.web3.eth.getTransactionCount(address, (error, count) => {
        console.log("Current "+  JSON.stringify(this.currentNonce))
        console.log("count "+  JSON.stringify(count))
        if (!this.currentNonce || count > this.currentNonce) {
          this.currentNonce = count;
        } else {
          this.currentNonce += 1;
        }
        callback(this.currentNonce);
      });
    }, 1);
  }

  startWeb3Provider(callback) {
    const self = this;

    if (this.type === 'rpc') {
      self.provider = new this.web3.providers.HttpProvider(self.web3Endpoint);
    } else if (this.type === 'ws') {
      self.provider = new this.web3.providers.WebsocketProvider(self.web3Endpoint, {headers: {Origin: "embark"}});
      self.provider.on('error', e => self.logger.error('Websocket Error', e));
      self.provider.on('end', e => self.logger.error('Websocket connection ended', e));
    } else {
      return callback(__("contracts config error: unknown deployment type %s", this.type));
    }

    self.web3.setProvider(self.provider);

    self.accounts = AccountParser.parseAccountsConfig(self.accountsConfig, self.web3, self.logger);
    self.addresses = [];

    self.accounts.forEach(account => {
      self.addresses.push(account.address);
      self.web3.eth.accounts.wallet.add(account);
    });
    self.web3.eth.defaultAccount = self.addresses[0];
    const realSend = self.provider.send.bind(self.provider);

    function blockTagParamIndex(payload){
      switch(payload.method) {
        // blockTag is third param
        case 'eth_getStorageAt':
          return 2
        // blockTag is second param
        case 'eth_getBalance':
        case 'eth_getCode':
        case 'eth_getTransactionCount':
        case 'eth_call':
        case 'eth_estimateGas':
          return 1
        // blockTag is first param
        case 'eth_getBlockByNumber':
          return 0
        // there is no blockTag
        default:
          return undefined
      }
    }

    function blockTagForPayload(payload){
      var index = blockTagParamIndex(payload);

      // Block tag param not passed.
      if (index >= payload.params.length) {
        return null;
      }

      return payload.params[index];
    }

    self.provider.send = function (payload, cb) {
      if (payload.method === 'eth_accounts') {
        return realSend(payload, function (err, result) {
          if (err) {
            return cb(err);
          }
          result.result = result.result.concat(self.addresses);
          cb(null, result);
        });
      }

      // if (payload.method === 'eth_getTransactionCount') {
      //   var blockTag = blockTagForPayload(payload)
      //   var address = payload.params[0].toLowerCase()
      //   var cachedResult = self.nonceCache[address]
      //   if (blockTag === 'latest') {
      //     if (cachedResult) {
      //       return cb(null, cachedResult);
      //     }
      //     return realSend(payload, (err, result) => {
      //       if (err) return cb(err)
      //       if (self.nonceCache[address] === undefined) {
      //         self.nonceCache[address] = result;
      //       }
      //       cb(err, result);
      //     });
      //   }
      // }

      if (payload.method === 'eth_sendRawTransaction') {
        var rawTx = payload.params[0];
        const rawData = Buffer.from(ethUtil.stripHexPrefix(rawTx), 'hex');
        const tx = new Transaction(rawData);
        const address = '0x'+tx.getSenderAddress().toString('hex').toLowerCase();
        return self.transactionCountQueue.push({address}, (nonce)  => {
          const txParams = {
            nonce: self.web3.utils.fromDecimal(nonce),
            gasPrice: tx.gasPrice,
            gasLimit: tx.gasLimit,
            to: tx.to,
            value: tx.value,
            data: tx.data,
          }

          const newTx = new Transaction(txParams)
          // let newNonce = Buffer.from(ethUtil.stripHexPrefix(self.web3.utils.fromDecimal(nonce)), 'hex');
          // console.log(JSON.stringify(newNonce))
          // tx.nonce = newNonce;
          // console.log(JSON.stringify(tx.nonce))
          realSend(newTx.serialize(), cb);
        });
      }
      //   return realSend(payload, (err, result) => {

      //     console.log(JSON.stringify(err))
      //     if (err) return cb(err);
      //     var rawTx = payload.params[0];
      //     const rawData = Buffer.from(ethUtil.stripHexPrefix(rawTx), 'hex');
      //     const tx = new Transaction(rawData);
      //     const address = '0x'+tx.getSenderAddress().toString('hex').toLowerCase();
      //     let nonce = ethUtil.bufferToInt(tx.nonce);
      //     nonce++;
      //     let hexNonce = nonce.toString(16);
      //     if (hexNonce.length%2) hexNonce = '0' + hexNonce;
      //     hexNonce = '0x' + hexNonce;
      //     self.nonceCache[address] = hexNonce;
      //     cb(err, result);
      //   });
      // }
      realSend(payload, cb);
    };

    callback();
  }

  stop() {
    if (this.provider && this.provider.removeAllListeners) {
      this.provider.removeAllListeners('connect');
      this.provider.removeAllListeners('error');
      this.provider.removeAllListeners('end');
      this.provider.removeAllListeners('data');
      this.provider.responseCallbacks = {};
      this.provider = null;
    }
  }

  fundAccounts(callback) {
    const self = this;
    if (!self.accounts.length) {
      return callback();
    }
    if (!self.isDev) {
      return callback();
    }
    async.eachLimit(self.accounts, 1, (account, eachCb) => {
      fundAccount(self.web3, account.address, account.hexBalance, eachCb);
    }, callback);
  }
}

module.exports = Provider;
