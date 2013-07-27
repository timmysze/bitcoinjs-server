var Util = require('../util');
var logger = require('../logger');
var Script = require('../script').Script;
var bignum = require('bignum');
var Binary = require('binary');
var Step = require('step');
var SchemaTransaction = require('./transaction');
var Transaction = SchemaTransaction.Transaction;
var TransactionIn = SchemaTransaction.TransactionIn;
var TransactionOut = SchemaTransaction.TransactionOut;
var COINBASE_OP = SchemaTransaction.COINBASE_OP;


var VerificationError = require('../error').VerificationError;

var BlockRules = exports.BlockRules = {
  maxTimeOffset: 2 * 60 * 60,  // How far block timestamps can be into the future
  largestHash: bignum(2).pow(256)
};

var Block = exports.Block =
function Block (data)
{
  if ("object" !== typeof data) {
    data = {};
  }
  this.hash = data.hash || null;
  this.prev_hash = data.prev_hash || Util.NULL_HASH;
  this.merkle_root = data.merkle_root || Util.NULL_HASH;
  this.timestamp = data.timestamp || 0;
  this.bits = data.bits || 0;
  this.nonce = data.nonce || 0;
  this.version = data.version || 0;
  this.height = data.height || 0;
  console.log('block constructor: data.height: ', data.height)
  this.size = data.size || 0;
  this.active = data.active || false;
  this.chainWork = data.chainWork || Util.EMPTY_BUFFER;
  this.txs = data.txs || [];
};

Block.prototype.getHeader = function getHeader() {
  put = Binary.put();
  put.word32le(this.version);
  put.put(this.prev_hash);
  put.put(this.merkle_root);
  put.word32le(this.timestamp);
  put.word32le(this.bits);
  put.word32le(this.nonce);
  return put.buffer();
};

Block.prototype.calcHash = function calcHash() {
  var header = this.getHeader();

  return Util.twoSha256(header);
};

Block.prototype.checkHash = function checkHash() {
  if (!this.hash || !this.hash.length) return false;
  return this.calcHash().compare(this.hash) == 0;
};

Block.prototype.getHash = function getHash() {
  if (!this.hash || !this.hash.length) this.hash = this.calcHash();

  return this.hash;
};

Block.prototype.checkProofOfWork = function checkProofOfWork() {
  var target = Util.decodeDiffBits(this.bits);

  // TODO: Create a compare method in node-buffertools that uses the correct
  //       endian so we don't have to reverse both buffers before comparing.
  this.hash.reverse();

  if (this.hash.compare(target) > 0) {
    throw new VerificationError('Difficulty target not met');
  }

  // Return the hash to its normal order
  this.hash.reverse();

  return true;
};

/**
 * Returns the amount of work that went into this block.
 *
 * Work is defined as the average number of tries required to meet this
 * block's difficulty target. For example a target that is greater than 5%
 * of all possible hashes would mean that 20 "work" is required to meet it.
 */
Block.prototype.getWork = function getWork() {
  var target = Util.decodeDiffBits(this.bits, true);
  return BlockRules.largestHash.div(target.add(1));
};

Block.prototype.checkTimestamp = function checkTimestamp() {
  var currentTime = new Date().getTime() / 1000;
  if (this.timestamp > currentTime + BlockRules.maxTimeOffset) {
    throw new VerificationError('Timestamp too far into the future');
  }

  return true;
};

Block.prototype.checkTransactions = function checkTransactions(txs) {
  if (!Array.isArray(txs) || txs.length <= 0) {
    throw new VerificationError('No transactions');
  }
  if (!txs[0].isCoinBase()) {
    throw new VerificationError('First tx must be coinbase');
  }
  for (var i = 1; i < txs.length; i++) {
    if (txs[i].isCoinBase()) {
      throw new VerificationError('Tx index '+i+' must not be coinbase');
    }
  }

  return true;
};

/**
 * Build merkle tree.
 *
 * Ported from Java. Original code: BitcoinJ by Mike Hearn
 * Copyright (c) 2011 Google Inc.
 */
Block.prototype.getMerkleTree = function getMerkleTree(txs) {
  // The merkle hash is based on a tree of hashes calculated from the transactions:
  //
  //          merkleHash
  //             /\
  //            /  \
  //          A      B
  //         / \    / \
  //       tx1 tx2 tx3 tx4
  //
  // Basically transactions are hashed, then the hashes of the transactions are hashed
  // again and so on upwards into the tree. The point of this scheme is to allow for
  // disk space savings later on.
  //
  // This function is a direct translation of CBlock::BuildMerkleTree().

  if (txs.length == 0) {
    return [Util.NULL_HASH.slice(0)];
  }

  // Start by adding all the hashes of the transactions as leaves of the tree.
  var tree = txs.map(function (tx) {
    return tx instanceof Transaction ? tx.getHash() : tx;
  });

  var j = 0;
  // Now step through each level ...
  for (var size = txs.length; size > 1; size = Math.floor((size + 1) / 2)) {
    // and for each leaf on that level ..
    for (var i = 0; i < size; i += 2) {
      var i2 = Math.min(i + 1, size - 1);
      var a = tree[j + i];
      var b = tree[j + i2];
      tree.push(Util.twoSha256(a.concat(b)));
    }
    j += size;
  }

  return tree;
};

Block.prototype.calcMerkleRoot = function calcMerkleRoot(txs) {
  var tree = this.getMerkleTree(txs);
  return tree[tree.length - 1];
};

Block.prototype.checkMerkleRoot = function checkMerkleRoot(txs) {
  if (!this.merkle_root || !this.merkle_root.length) {
    throw new VerificationError('No merkle root');
  }

  if (this.calcMerkleRoot().compare(this.merkle_root) == 0) {
    throw new VerificationError('Merkle root incorrect');
  }

  return true;
};

Block.prototype.checkBlock = function checkBlock(txs) {
  if (!this.checkHash()) {
    throw new VerificationError("Block hash invalid");
  }
  this.checkProofOfWork();
  this.checkTimestamp();

  if (txs) {
    this.checkTransactions(txs);
    if (!this.checkMerkleRoot(txs)) {
      throw new VerificationError("Merkle hash invalid");
    }
  }
  return true;
};

Block.getBlockValue = function getBlockValue(height) {
  var subsidy = bignum(50).mul(Util.COIN);
  subsidy = subsidy.div(bignum(2).pow(Math.floor(height / 210000)));
  return subsidy;
};

Block.prototype.getBlockValue = function getBlockValue() {
  return Block.getBlockValue(this.height);
};

Block.prototype.toString = function toString() {
  return "<Block " + Util.formatHashAlt(this.hash) + " height="+this.height+">";
};

/**
 * Initializes some properties based on information from the parent block.
 */
Block.prototype.attachTo = function attachTo(parent) {
  this.height = parent.height + 1;
  console.log('block: attachTo: this.height: ', this.height)
  this.setChainWork(parent.getChainWork().add(this.getWork()));
};

Block.prototype.setChainWork = function setChainWork(chainWork) {
  if (Buffer.isBuffer(chainWork)) {
    // Nothing to do
  } else if ("function" === typeof chainWork.toBuffer) { // duck-typing bignum
    chainWork = chainWork.toBuffer();
  } else {
    throw new Error("Block.setChainWork(): Invalid datatype");
  }

  this.chainWork = chainWork;
};

Block.prototype.getChainWork = function getChainWork() {
  return bignum.fromBuffer(this.chainWork);
};

/**
 * Compares the chainWork of two blocks.
 */
Block.prototype.moreWorkThan = function moreWorkThan(otherBlock) {
  return this.getChainWork().cmp(otherBlock.getChainWork()) > 0;
};

/**
 * Returns the difficulty target for the next block after this one.
 */
Block.prototype.getNextWork =
function getNextWork(blockChain, nextBlock, callback) {
  var self = this;

  var powLimit = blockChain.getMinDiff();
  var powLimitTarget = Util.decodeDiffBits(powLimit, true);

  var targetTimespan = blockChain.getTargetTimespan();
  var targetSpacing = blockChain.getTargetSpacing();
  var interval = targetTimespan / targetSpacing;

  if (this.height == 0) {
    callback(null, this.bits);
  }

  if ((this.height+1) % interval !== 0) {
    if (blockChain.isTestnet()) {
      // Special testnet difficulty rules
      var lastBlock = blockChain.getTopBlock();

      // If the new block's timestamp is more than 2 * 10 minutes
      // then allow mining of a min-difficulty block.
      if (nextBlock.timestamp > this.timestamp + targetSpacing*2) {
        callback(null, powLimit);
      } else {
        // Return last non-"special-min-difficulty" block
        if (this.bits != powLimit) {
          // Current block is non-min-diff
          callback(null, this.bits);
        } else {
          // Recurse backwards until a non min-diff block is found.
          function lookForLastNonMinDiff(block, callback) {
            try {
              if (block.height > 0 &&
                  block.height % interval !== 0 &&
                  block.bits == powLimit) {
                blockChain.getBlockByHeight(
                  block.height - 1,
                  function (err, lastBlock) {
                    try {
                      if (err) throw err;
                      lookForLastNonMinDiff(lastBlock, callback);
                    } catch (err) {
                      callback(err);
                    }
                  }
                );
              } else {
                callback(null, block.bits);
              }
            } catch (err) {
              callback(err);
            }
          };
          lookForLastNonMinDiff(this, callback);
        }
      }
    } else {
      // Not adjustment interval, next block has same difficulty
      callback(null, this.bits);
    }
  } else {
    // Get the first block from the old difficulty period
    blockChain.getBlockByHeight(
      this.height - interval + 1,
      function (err, lastBlock) {
        try {
          if (err) throw err;

          // Determine how long the difficulty period really took
          var actualTimespan = self.timestamp - lastBlock.timestamp;

          // There are some limits to how much we will adjust the difficulty in
          // one step
          if (actualTimespan < targetTimespan/4) {
            actualTimespan = targetTimespan/4;
          }
          if (actualTimespan > targetTimespan*4) {
            actualTimespan = targetTimespan*4;
          }

          var oldTarget = Util.decodeDiffBits(self.bits, true);
          var newTarget = oldTarget.mul(actualTimespan).div(targetTimespan);

          if (newTarget.cmp(powLimitTarget) > 0) {
            newTarget = powLimitTarget;
          }

          logger.bchdbg('Difficulty retarget (target='+targetTimespan +
                        ', actual='+actualTimespan+')');
          logger.bchdbg('Before: '+Util.encodeHex(oldTarget.toBuffer()));
          logger.bchdbg('After:  '+Util.encodeHex(newTarget.toBuffer()));

          callback(null, Util.encodeDiffBits(newTarget));
        } catch (err) {
          callback(err);
        }
      }
    );
  }
};

var medianTimeSpan = 11;

Block.prototype.getMedianTimePast =
function getMedianTimePast(blockChain, callback)
{
  var self = this;

  Step(
    function getBlocks() {
      var heights = [];
      for (var i = 0, m = medianTimeSpan; i < m && (self.height - i) >= 0; i++) {
        heights.push(self.height - i);
      }
      // TIM: HERE IS THE BUG!!!
      console.log('self.height: ', self.height)
      console.log('heights to input to getBlocksByHeights: ', heights)
      blockChain.getBlocksByHeights(heights, this);
      console.log('block: getMedianTimePast: get blocks')
    },
    function calcMedian(err, blocks) {
      console.log('calc median')
      if (err) throw err;

        console.log('time stamps')
      var timestamps = blocks.map(function (block) {
        if (!block) {
          throw new Error("Prior block missing, cannot calculate median time");
        }
        return +block.timestamp;
      });

      // Sort timestamps
      timestamps = timestamps.sort();

      // Return median timestamp
      this(null, timestamps[Math.floor(timestamps.length/2)]);
      // TIM:
      console.log('get median time past')
    },
    callback
  );
};

Block.prototype.verifyChild =
function verifyChild(blockChain, child, callback)
{
  console.log('verifying child')
  var self = this;

  Step(
    function getExpectedDifficulty() {
      console.log('verifying child: get expec diff')
      self.getNextWork(blockChain, child, this);
    },
    function verifyExpectedDifficulty(err, nextWork) {
      console.log('verifying child: verify expec diff')
      if (err) throw err;

      if (+child.bits !== +nextWork) {
        throw new VerificationError("Incorrect proof of work '"+child.bits+"',"+
                                    " should be '"+nextWork+"'.");
      }

      this();
    },
    function getMinimumTimestamp(err) {
      if (err) throw err;

      self.getMedianTimePast(blockChain, this);
      console.log('verifying child: get min timestamp')
      // TIM: added this
      // this();
    },
    function verifyTimestamp(err, medianTimePast) {
      console.log('verifying child: verify timestamp')
      console.log(err)
      if (err) throw err;

      if (child.timestamp <= medianTimePast) {
        throw new VerificationError("Block's timestamp is too early");
      }

      this();
    },
    callback
  );
};

Block.prototype.createCoinbaseTx =
function createCoinbaseTx(beneficiary)
{
  var tx = new Transaction();
  tx.ins.push(new TransactionIn({
    s: Util.EMPTY_BUFFER,
    q: 0xffffffff,
    o: COINBASE_OP
  }));
  tx.outs.push(new TransactionOut({
    v: Util.bigIntToValue(this.getBlockValue()),
    s: Script.createPubKeyOut(beneficiary).getBuffer()
  }));
  return tx;
};

Block.prototype.prepareNextBlock =
function prepareNextBlock(blockChain, beneficiary, time, callback)
{
  var self = this;

  var newBlock = new Block();
  Step(
    function getMedianTimePastStep() {
      self.getMedianTimePast(blockChain, this);
    },

    function getNextWorkStep(err, medianTimePast) {
      if (err) throw err;

      if (!time) {
        // TODO: Use getAdjustedTime for the second timestamp
        time = Math.max(medianTimePast+1,
                        Math.floor(new Date().getTime() / 1000));
      }

      self.getNextWork(blockChain, newBlock, this);
    },

    function applyNextWorkStep(err, nextWork) {
      if (err) throw err;
      newBlock.bits = nextWork;
      this(null);
    },

    function miscStep(err) {
      if (err) throw err;

      newBlock.version = 1;
      newBlock.timestamp = time;
      newBlock.prev_hash = self.getHash().slice(0);
      newBlock.height = self.height+1;

      // Create coinbase transaction
      var txs = [];

      var tx = newBlock.createCoinbaseTx(beneficiary);
      txs.push(tx);

      newBlock.merkle_root = newBlock.calcMerkleRoot(txs);

      // Return reference to (unfinished) block
      this(null, {block: newBlock, txs: txs});
    },
    callback
  );
};

Block.prototype.mineNextBlock =
function mineNextBlock(blockChain, beneficiary, time, miner, callback)
{
  this.prepareNextBlock(blockChain, beneficiary, time, function (err, data) {
    try {
      if (err) throw err;

      var newBlock = data.block;
      var txs = data.txs;

      newBlock.solve(miner, function (err, nonce) {
        newBlock.nonce = nonce;

        // Make sure hash is cached
        newBlock.getHash();

        callback(err, newBlock, txs);
      });

      // Return reference to (unfinished) block
      return newBlock;
    } catch (e) {
      callback(e);
    }
  });
};

Block.prototype.solve = function solve(miner, callback) {
  var header = this.getHeader();
  var target = Util.decodeDiffBits(this.bits);
  miner.solve(header, target, callback);
};

/**
 * Returns an object with the same field names as jgarzik's getblock patch.
 */
Block.prototype.getStandardizedObject =
function getStandardizedObject(txs)
{
  var block = {
    hash: Util.formatHashFull(this.getHash()),
    version: this.version,
    prev_block: Util.formatHashFull(this.prev_hash),
    mrkl_root: Util.formatHashFull(this.merkle_root),
    time: this.timestamp,
    bits: this.bits,
    nonce: this.nonce,
    height: this.height
  };


  if (txs) {
    var mrkl_tree = this.getMerkleTree(txs).map(function (buffer) {
      return Util.formatHashFull(buffer);
    });
    block.mrkl_root = mrkl_tree[mrkl_tree.length - 1];

    block.n_tx = txs.length;
    var totalSize = 80; // Block header
    totalSize += Util.getVarIntSize(txs.length); // txn_count
    txs = txs.map(function (tx) {
      tx = tx.getStandardizedObject();
      totalSize += tx.size;
      return tx;
    });
    block.size = totalSize;
    block.tx = txs;

    block.mrkl_tree = mrkl_tree;
  } else {
    block.size = this.size;
  }
  return block;
};

