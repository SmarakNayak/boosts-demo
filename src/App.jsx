import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'
import * as ecc from '@cmdcode/crypto-utils'
import { Address, Signer, Tap, Tx } from '@cmdcode/tapscript'
import * as bitcoin from 'bitcoinjs-lib'
import { isP2PKH, isP2SHScript, isP2WPKH, isP2TR } from 'bitcoinjs-lib/src/psbt/psbtutils'
import { toXOnly } from 'bitcoinjs-lib/src/psbt/bip371'
import * as bip39 from 'bip39'
import * as ecc2 from '@bitcoinerlab/secp256k1'
import { BIP32Factory } from 'bip32'


const bip32 = BIP32Factory(ecc2);
bitcoin.initEccLib(ecc2);

async function generatePrivateKey() {
  const entropy = crypto.getRandomValues(new Uint8Array(32))
  const mnemonic = bip39.entropyToMnemonic(Buffer.from(entropy))
  const seed = await bip39.mnemonicToSeed(mnemonic)
  const root = bip32.fromSeed(seed, bitcoin.networks.testnet)
  return root?.derivePath("m/44'/0'/0'/0/0").privateKey
}

class Inscription {
  constructor({
    content = null,
    contentType = null,
    contentEncoding = null,
    metaprotocol = null,
    //parent = null,
    delegate = null,
    //pointer = null,
    //metadata = null,
    //rune = null,
  }) {
    this.content = content;
    this.contentType = contentType;
    this.contentEncoding = contentEncoding;
    this.metaprotocol = metaprotocol;
    //this.parent = parent;
    this.delegate = delegate;
    //this.pointer = pointer;
    //this.metadata = metadata;
    //this.rune = rune;
  }

  getInscriptionScript() {
    let ec = new TextEncoder();
    const script = ['OP_0', 'OP_IF', ec.encode('ord')];
    if (this.contentType !== null) {
      script.push('1', ec.encode(this.contentType));
    }
    if (this.contentEncoding !== null) {
      script.push('9', ec.encode(this.contentEncoding));
    }
    if (this.metaprotocol !== null) {
      script.push('7', ec.encode(this.metaprotocol));
    }
    if (this.delegate !== null) {
      script.push('11', getDelegateBytes(this.delegate));
    }
    if (this.metadata !== null) {
      //script.push('5', ec.encode(this.metadata));
    }

    if (this.content !== null && this.content.length > 0) {
      script.push("OP_0");
      const contentChunks = [];
      for (let i = 0; i < this.content.length; i += 520) {
        contentChunks.push(this.content.subarray(i, i + 520));
      }
      script.push(...contentChunks);
    }

    script.push('OP_ENDIF');
    return script;
  }
}

function App() {
  const [unisatProvider, setUnisatProvider] = useState(null);
  const [address, setAddress] = useState(null);
  const [publicKey, setPublicKey] = useState(null);

  const connectUnisat = async () => {
    if (window.unisat) {
      try {
        // Set the provider
        setUnisatProvider(window.unisat);
        console.log(window.unisat);
        // Set the chain
        let chain = await window.unisat.getChain();
        console.log(chain);
        if (chain.enum !== "BITCOIN_TESTNET4") {
          window.unisat.switchChain("BITCOIN_TESTNET4");
        }
        // Set the address
        let addy = await window.unisat.requestAccounts();
        console.log(addy);
        setAddress(addy[0]);
        // Set the public key
        let pubKey = await window.unisat.getPublicKey();
        console.log(pubKey);
        setPublicKey(pubKey);
      } catch (error) {
        console.error(error);
      }
    } else {
      console.log("Unisat Wallet not found");
    }
  }

  const createInscription = async () => {
    let revealPrivateKeyBuffer = await generatePrivateKey();
    let revealPrivateKey = Buffer.from(revealPrivateKeyBuffer).toString('hex');
    let utxos = await getConfirmedCardinalUtxos(address);
    let ec = new TextEncoder();
    let inscriptions = [new Inscription({
      content: ec.encode("Chancellor on the brink of second bailout for banks"),
      contentType: "text/plain;charset=utf-8"
    })];
    let [dummyRevealTransaction, estRevealVSize] = getRevealTransaction(inscriptions, address, revealPrivateKey, "0".repeat(64), 0);
    let [commitPsbt, estimatedRevealFee ]= await getCommitTransaction(inscriptions, address, publicKey, revealPrivateKey, estRevealVSize);
    let signedCommitHex = await unisatProvider.signPsbt(commitPsbt.toHex());
    let signedPsbt = bitcoin.Psbt.fromHex(signedCommitHex);    
    let commitTx = signedPsbt.extractTransaction();
    let commitTxId = commitTx.getId();
    console.log("Actual commit vsize", commitTx.virtualSize());
    let [revealTransaction, revealVSize] = getRevealTransaction(inscriptions, address, revealPrivateKey, commitTxId, estimatedRevealFee);
    let pushedCommitTx = await broadcastTx(commitTx.toHex());
    await new Promise(resolve => setTimeout(resolve, 2500));
    let pushedRevealTx = await broadcastTx(Tx.encode(revealTransaction).hex);
    console.log(pushedCommitTx, pushedRevealTx);
  }

  const getRevealScript = (inscriptions, revealPublicKey) => {
    let script = [revealPublicKey, 'OP_CHECKSIG'];
    for (let i = 0; i < inscriptions.length; i++) {
      const inscription = inscriptions[i];
      const inscriptionScript = inscription.getInscriptionScript();
      script.push(...inscriptionScript);
    }
    console.log(script);
    return script;
  }

  const getRevealTransaction = (inscriptions, inscriptionReceiveAddress, revealPrivateKey, commitTxId, revealFee) => {
    const secKey = ecc.keys.get_seckey(revealPrivateKey);
    const pubKey = ecc.keys.get_pubkey(revealPrivateKey, true);
    const script = getRevealScript(inscriptions, pubKey);
    const tapleaf = Tap.encodeScript(script);
    const [tpubkey, cblock] = Tap.getPubKey(pubKey, { target: tapleaf });

    let inputs = [{
      txid: commitTxId,
      vout: 0,
      prevout:{
        value: revealFee,
        scriptPubKey: ['OP_1', tpubkey]
      }
    }];

    let outputs = inscriptions.map(() => ({
      value: 546,
      scriptPubKey: Address.toScriptPubKey(inscriptionReceiveAddress)
    }));

    let txData = Tx.create({
      vin: inputs,
      vout: outputs
    });

    const sig = Signer.taproot.sign(secKey, txData, 0, { extension: tapleaf });
    txData.vin[0].witness = [sig, script, cblock];

    let sizeData = Tx.util.getTxSize(txData);
    let vSize = sizeData.vsize;

    return [txData, vSize];
  }

  const getCommitTransaction = async(inscriptions, paymentAddress, paymentPublicKey, revealPrivateKey, revealVSize) => {
    let revealPublicKey = ecc.keys.get_pubkey(revealPrivateKey, true);
    let revealScript = getRevealScript(inscriptions, revealPublicKey);
    let tapleaf = Tap.encodeScript(revealScript); // sha256 hash of the script buffer in hex
    const [tRevealPublicKey, cblock] = Tap.getPubKey(revealPublicKey, { target: tapleaf }); // tweak the public key using the tapleaf
    const commitAddress = Address.p2tr.fromPubKey(tRevealPublicKey, "testnet");

    const paymentAddressScript = bitcoin.address.toOutputScript(paymentAddress, bitcoin.networks.testnet);
    const paymentAddressType = getAddressType(paymentAddressScript);
    console.log(paymentAddressType);

    let feeRate = await getRecommendedFees();
    let estimatedCommitFeeForHeaderAndOutputs = (10.5 + 2 * 43) * feeRate; //tx header 10.5 vBytes, 2 taproot outputs 43 vBytes each - input vB handled in selection
    let estimatedRevealFee = Math.ceil(revealVSize * feeRate + inscriptions.length * 546);

    let utxos = await getConfirmedCardinalUtxos(paymentAddress);
    let adjustedUtxos = appendUtxoEffectiveValues(utxos, paymentAddressType, feeRate); //adjust utxos values to account for fee for size of input
    let selectedUtxos = selectUtxos(adjustedUtxos, estimatedRevealFee + estimatedCommitFeeForHeaderAndOutputs);
    console.log(selectedUtxos);

    let estimatedCommitFeeForInputs = selectedUtxos.reduce((acc, utxo) => acc + utxo.value - utxo.effectiveValue, 0);
    let estimatedCommitFee = Math.ceil(estimatedCommitFeeForHeaderAndOutputs + estimatedCommitFeeForInputs);
    console.log("Estimated commit fee: ", estimatedCommitFee, ". estimated commit vsize:", estimatedCommitFee / feeRate);
    console.log("Estimated commit input vsize: ", estimatedCommitFeeForInputs / feeRate, ". estimated commit output + header vsize:", estimatedCommitFeeForHeaderAndOutputs / feeRate);
    console.log("Estimated reveal fee: ", estimatedRevealFee);
    let estimatedInscriptionFee = estimatedCommitFee + estimatedRevealFee;

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
    
    // 1. inputs
    for (let i = 0; i < selectedUtxos.length; i++) {
      const utxo = selectedUtxos[i];

      switch (paymentAddressType) {
        case 'P2TR':
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: paymentAddressScript,
              value: utxo.value
            },
            tapInternalKey: toXOnly(Buffer.from(paymentPublicKey, 'hex')),
          });
          break;
        case 'P2WPKH':
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: paymentAddressScript,
              value: utxo.value
            }
          });
          break;
        case 'P2SH-P2WPKH':
          const p2wpkh = bitcoin.payments.p2wpkh({
            pubkey: Buffer.from(paymentPublicKey, 'hex')
          });
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: paymentAddressScript,
              value: utxo.value
            },
            redeemScript: p2wpkh.output
          });
          break;
        case 'P2PKH':
          const prevTx = await getTxData(utxo.txid);
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: Buffer.from(prevTx, 'hex'),
          });
          break;
        default:
          throw new Error("Unsupported address type");
      }
    }

    //2. outputs
    psbt.addOutput({
      address: commitAddress,
      value: estimatedRevealFee
    });

    let change = selectedUtxos.reduce((acc, utxo) => acc + utxo.value, 0) - estimatedInscriptionFee;
    if (change >= 546) {
      psbt.addOutput({
        address: address,
        value: change
      });
    }

    return [psbt, estimatedRevealFee];

  }

  const getCommitTx = async(content, mimeType, address, publicKey, revealPrivateKey) => {
    let contentLength = Buffer.byteLength(content);
    if (contentLength > 390_000) {
      console.log("Content too long");
    }
    let fee = await getRecommendedFees();
    let revealPublicKey = ecc.keys.get_pubkey(String(revealPrivateKey), true);
    const script = createInscriptionScript(revealPublicKey, content, mimeType);
    const tapleaf = Tap.encodeScript(script);
    const tpubkey = Tap.getPubKey(revealPublicKey,{target: tapleaf});
    console.log(tpubkey);
    const inscriberAddress = Address.p2tr.fromPubKey(
      tpubkey[0],
      "testnet"
    )
    console.log(inscriberAddress);
    let estimatedCommitSize = 154;
    let estimatedCommitFee = fee * estimatedCommitSize;
    let estimatedRevealFee = Math.ceil((contentLength * fee)/4) + 1000 + 546;
    let estimatedInscriptionFee = estimatedCommitFee + estimatedRevealFee;
    let utxos = await getConfirmedCardinalUtxos(address);
    let selectedUtxos = selectUtxos(utxos, estimatedInscriptionFee);
    console.log(estimatedInscriptionFee);
    console.log(selectedUtxos);

    
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
    // 1. inputs
    const addressScript = bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
    for (let i = 0; i < selectedUtxos.length; i++) {
      const utxo = selectedUtxos[i];
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: addressScript,
          value: utxo.value
        }
      });

      // taproot
      if (isP2TR(addressScript)) {
        psbt.updateInput(i, {
          tapInternalKey: toXOnly(Buffer.from(publicKey, 'hex')),
        });
      }

      // TODO: Add support for P2PKH (1), Nested segwit (3)
    }

    //2. outputs
    psbt.addOutput({
      address: inscriberAddress,
      value: estimatedRevealFee
    });

    let change = selectedUtxos.reduce((acc, utxo) => acc + utxo.value, 0) - estimatedInscriptionFee;
    if (change >= 546) {
      psbt.addOutput({
        address: address,
        value: change
      });
    }

    return [psbt, estimatedRevealFee];
  }

  const getRevealTx = async(content, mimeType, address, publicKey, revealPrivateKey, commitTxId, revealFee) => {
    const secKey = ecc.keys.get_seckey(revealPrivateKey);
    const pubKey = ecc.keys.get_pubkey(revealPrivateKey, true);
    const script = createInscriptionScript(pubKey, content, mimeType);
    const tapleaf = Tap.encodeScript(script);
    const [tpubkey, cblock] = Tap.getPubKey(pubKey, { target: tapleaf });

    let txData = Tx.create({
      vin: [{
        txid: commitTxId,
        vout: 0,
        prevout: {
          value: revealFee,
          scriptPubKey: ['OP_1', tpubkey]
        }
      }],
      vout: [{
        value: 546,
        scriptPubKey: Address.toScriptPubKey(address)
      }]
    });

    const sig = Signer.taproot.sign(secKey, txData, 0, { extension: tapleaf });
    txData.vin[0].witness = [sig, script, cblock];
    console.log(Tx.encode(txData).hex);
    await new Promise(resolve => setTimeout(resolve, 2500));
    return await broadcastTx(Tx.encode(txData).hex);
  }

  async function broadcastTx(txHex) {
    const url = `https://mempool.space/testnet4/api/tx`;
  
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: txHex,
    });
  
    if (!response.ok) {
      console.log(response);
      throw new Error(`Failed to broadcast transaction: ${response.statusText}`);
    }
  
    const data = await response.text();
    return data;
  }

  async function submitPackage(commitHex, revealHex) {
    const url = `https://mempool.space/testnet4/api/v1/txs/package?maxfeerate=100`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify([commitHex, revealHex]),
    });

    if (!response.ok) {
      console.log(response);
      throw new Error(`Failed to broadcast transactions: ${response.statusText}`);
    }

    const data = await response.text();
    return data;
  }

  const getRecommendedFees = async() => {
    let fees = await fetch("https://mempool.space/testnet4/api/v1/fees/recommended");
    let feesJson = await fees.json();
    let fastestFee = feesJson.fastestFee;
    return fastestFee;
  }

  const getConfirmedCardinalUtxos = async(address) => {
    // "https://ordinals.com/outputs/<address>?type=cardinal"
    let utxos = await fetch(`https://mempool.space/testnet4/api/address/${address}/utxo`);
    let utxosJson = await utxos.json();
    console.log(utxosJson);
    let confirmedUtxos = utxosJson.filter(utxo => utxo.status.confirmed == true);
    confirmedUtxos = confirmedUtxos.filter(utxo => utxo.value > 1000);
    console.log(confirmedUtxos);
    return confirmedUtxos;
  }

  const getTxData = async(txId) => {
    let txData = await fetch(`https://mempool.space/testnet4/api/tx/${txId}/hex`);
    let txDataJson = await txData.json();
    return txDataJson;
  }

  const appendUtxoEffectiveValues = (utxos, addressType, feeRate) => {
    //https://bitcoin.stackexchange.com/questions/84004/how-do-virtual-size-stripped-size-and-raw-size-compare-between-legacy-address-f/84006#84006
    if (addressType === 'P2TR') {
      utxos.map(utxo => {
        utxo.effectiveValue = utxo.value - feeRate * (40 + 1 + 66/4);
      });
    }
    if (addressType === 'P2WPKH') {
      utxos.map(utxo => {
        utxo.effectiveValue = utxo.value - feeRate * (40 + 1 + 108/4);
      });
    }
    if (addressType === 'P2SH-P2WPKH') {
      utxos.map(utxo => {
        utxo.effectiveValue = utxo.value - feeRate * (40 + 24 + 108/4);
      });
    }
    if (addressType === 'P2PKH') {
      utxos.map(utxo => {
        utxo.effectiveValue = utxo.value - feeRate * (40 + 108);
      });
    }
    return utxos;
  }

  const selectUtxos = (utxos, targetAmount) => {
    utxos.sort((a, b) => a.effectiveValue - b.effectiveValue);
    
    // 1. Exact match
    for (let i = 0; i < utxos.length; i++) {
      if (utxos[i].effectiveValue === targetAmount) {
        return [utxos[i]];
      }
    }
    
    // 2. Branch and Bound
    let selectedUtxos = branchAndBound(utxos, targetAmount);
    if (selectedUtxos) {
      return selectedUtxos;
    }

    // 3. Accumulator Fallback
    selected = [];
    totalInput = 0;
    for (let i = 0; i < utxos.length; i++) {
      selected.push(utxos[i]);
      totalInput += utxos[i].effectiveValue;
      if (totalInput >= targetAmount) {
        return selected;
      }
    }

    return null;
  }

  const branchAndBound = (utxos, targetAmount) => {
    let bestSolution = null;
    let minWaste = Infinity;

    const explore = (remainingUtxos, selectedUtxos, currentSum, depth) => {
      // Base case
      if (currentSum >= targetAmount) {
        let waste = currentSum - targetAmount;
        if (waste < minWaste) {
          bestSolution = selectedUtxos;
          minWaste = waste;
        }
        return;
      }
      // Pruning: unreachable target
      if (currentSum + remainingUtxos.reduce((acc, utxo) => acc + utxo.effectiveValue, 0) < targetAmount) {
        return;
      }
      // Pruning: too deep
      if (depth > remainingUtxos.length) {
        return;
      }
      //Branch
      for (let i = 0; i < remainingUtxos.length; i++) {
        // moving across the tree - add one utxo to the selected utxos
        // if target is hit, stop
        // if target is not hit, move across the tree again and add another utxo
        // repeat until target is hit
        let newRemainingUtxos = remainingUtxos.slice(i + 1);
        let newSelectedUtxos = selectedUtxos.concat(remainingUtxos[i]);
        let newSum = currentSum + remainingUtxos[i].effectiveValue;
        explore(newRemainingUtxos, newSelectedUtxos, newSum, depth + 1);
      }
    }
    explore(utxos, [], 0, 0);
    return bestSolution;
  }


  const createInscriptionScript = (revealPublicKey, content, mimeType) => {
    let ec = new TextEncoder();
    let marker = ec.encode('ord');

    let contentBuffer = Buffer.from(content, 'utf8');
    const contentChunks = [];
    for (let i = 0; i < contentBuffer.length; i += 520) {
      contentChunks.push(contentBuffer.subarray(i, i + 520));
    }

    const script = [revealPublicKey, 'OP_CHECKSIG'];
    script.push('OP_0', 'OP_IF', marker, '01', ec.encode(mimeType), 'OP_0');
    script.push(...contentChunks, 'OP_ENDIF');
    return script;
  }

  const createDelegateScript = (revealPublicKey, delegateId, mimeType) => {
    let ec = new TextEncoder();
    let marker = ec.encode('ord');

    const script = [revealPublicKey, 'OP_CHECKSIG'];
    script.push('OP_0', 'OP_IF', marker, '01', ec.encode(mimeType));
    script.push('11', getDelegateBytes(delegateId));
    script.push('OP_ENDIF');
    return script;
  }

  const getDelegateBytes = (delegateId) => {
    const [txHash, index] = delegateId.split("i");
    const txHashBytes = Buffer.from(txHash, 'hex').reverse();
    const indexBytes = indexToBytes(parseInt(index));
    return Buffer.concat([txHashBytes, indexBytes]);
  }

  function indexToBytes(value) {
    const bytes = [];
    while (value > 0) {
      bytes.push(value & 0xff); //push smallest byte
      value >>= 8; //shift right 1 byte, look at next smallest byte
    }
    return Buffer.from(bytes);
  }

  const getAddressType = (addressScript, publicKey) => {
    if (isP2TR(addressScript)) {
      return 'P2TR';
    }
    if (isP2WPKH(addressScript)) {
      return 'P2WPKH';
    }
    if (isP2SHScript(addressScript)) {
      // for nested segwit, we have:
      // pubKey -> pubkeyhash -> pubkeyhashscript (witness program/p2pkh) -> pubkeyhashscripthash (witness program hash/scripthash) -> pubkeyhashscripthashscript (P2SH script)

      // Parse the P2SH script (OP_HASH160 <scripthash> OP_EQUAL) to extract the witness program hash stored inside it
      const p2sh = bitcoin.payments.p2sh({
        output: addressScript,
        network: bitcoin.networks.testnet
      })

      // Create pubkeyhash from pubkey
      const pubkeyHash = bitcoin.crypto.hash160(Buffer.from(publicKey, 'hex'))

      // Create the witness program (OP_0 <pubkeyhash>) that would be wrapped inside P2SH for this pubkey
      const p2wpkh = bitcoin.payments.p2wpkh({
        hash: pubkeyHash,
        network: bitcoin.networks.testnet
      })

      // Check if:
      // scripthash inside P2SH script (p2sh.hash) equals hash of witness program we generated (hash160(p2wpkh.output))
      // If equal -> this P2SH script is wrapping the SegWit script for this pubkey
      if (p2sh.hash.equals(bitcoin.crypto.hash160(p2wpkh.output))) {
        return 'P2SH-P2WPKH'
      } else {
        throw new Error("Unsupported address type");
      }
    }
    if (isP2PKH(addressScript)) {
      return 'P2PKH';
    }
    throw new Error("Unsupported address type");
  }


  return (
    <> 
      <button onClick={() => connectUnisat()}>Connect Wallet</button>

      <button onClick={() => createInscription()}>Create Inscription</button>
 
      <button onClick={()=>console.log("dc")}>Disconnect Wallet</button>
    </>
  )
}

export default App

//TODO: Backup Reveal Tx
//TODO: Support for different wallets