import { useState, useRef, useEffect } from 'react'
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

import {unisat, xverse, leather, okx, magiceden, phantom, oyl} from './wallets'
import { NETWORKS } from './networks'

const bip32 = BIP32Factory(ecc2);
bitcoin.initEccLib(ecc2);

async function generatePrivateKey(bitcoinjsNetwork) {
  const entropy = crypto.getRandomValues(new Uint8Array(32))
  const mnemonic = bip39.entropyToMnemonic(Buffer.from(entropy))
  const seed = await bip39.mnemonicToSeed(mnemonic)
  const root = bip32.fromSeed(seed, bitcoinjsNetwork)
  return root?.derivePath("m/44'/0'/0'/0/0").privateKey
}

const getDelegateBytes = (delegateId) => {
  const [txHash, index] = delegateId.split("i");
  const txHashBytes = Buffer.from(txHash, 'hex').reverse();
  const indexBytes = intToLeBytes(parseInt(index));
  return Buffer.concat([txHashBytes, indexBytes]);
}

const intToLeBytes = (value) => {
  const bytes = [];
  while (value > 0) {
    bytes.push(value & 0xff); //push smallest byte
    value >>= 8; //shift right 1 byte, look at next smallest byte
  }
  return Buffer.from(bytes);
}

class Inscription {
  constructor({
    content = null,
    contentType = null,
    contentEncoding = null,
    metaprotocol = null,
    //parent = null,
    delegate = null,
    pointer = null,
    //metadata = null,
    //rune = null,
    postage = 546
  }) {
    this.content = content;
    this.contentType = contentType;
    this.contentEncoding = contentEncoding;
    this.metaprotocol = metaprotocol;
    //this.parent = parent;
    this.delegate = delegate;
    this.pointer = pointer;
    //this.metadata = metadata;
    //this.rune = rune;
    this.postage = postage;
  }

  getInscriptionScript() {
    let ec = new TextEncoder();
    const script = ['OP_0', 'OP_IF', ec.encode('ord')];
    if (this.contentType !== null) {
      script.push(1, ec.encode(this.contentType));
    }
    if (this.pointer !== null) {
      script.push(2, intToLeBytes(this.pointer));
    }
    if (this.contentEncoding !== null) {
      script.push(9, ec.encode(this.contentEncoding));
    }
    if (this.metaprotocol !== null) {
      script.push(7, ec.encode(this.metaprotocol));
    }
    if (this.delegate !== null) {
      script.push(11, getDelegateBytes(this.delegate));
    }
    if (this.metadata !== null) {
      //script.push(5, ec.encode(this.metadata));
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
  const [network, setNetwork] = useState('mainnet');
  const [wallet, setWallet] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const connectWallet = async (walletType) => {
    let accounts = null;
    let walletInstance = null;
    switch (walletType) {
      case 'unisat':    
        walletInstance = unisat;
        break;
      case 'xverse':
        walletInstance = xverse;
        break;
      case 'leather':
        walletInstance = leather;
        break;
      case 'okx':
        walletInstance = okx;
        break;
      case 'magiceden':
        walletInstance = magiceden;
        break;
      case 'phantom':
        walletInstance = phantom;
        break;
      case 'oyl':
        walletInstance = oyl;
        break;
      default:
        throw new Error('Unsupported wallet type');
    }
    accounts = await walletInstance.connect(network);
    setWallet(walletInstance);
    setIsConnected(true);
    setIsModalOpen(false);
    walletInstance.setupAccountChangeListener((accounts) => {
      console.log(accounts);
      if (accounts?.disconnected === true) {
        setIsConnected(false);
        setWallet(null);
      } else {
        setWallet({...walletInstance});
      }      
    });
  }

  const disconnectWallet = async () => {
    await wallet.removeAccountChangeListener();
    setWallet(null);
    setIsConnected(false);
  }

  const createInscriptionProper = async () => {
    let revealPrivateKeyBuffer = await generatePrivateKey(NETWORKS[network].bitcoinjs);
    let revealPrivateKey = Buffer.from(revealPrivateKeyBuffer).toString('hex');
    let ec = new TextEncoder();
    let inscriptions = [
      new Inscription({
        content: ec.encode("Chancellor on the brink of second bailout for banks"),
        contentType: "text/plain;charset=utf-8"
      }),
      new Inscription({
        content: ec.encode("Chancellor on the brink of second bailout for banks: Billions may be needed as lending squeeze tightens"),
        contentType: "text/plain;charset=utf-8"
      }),
      new Inscription({
        content: ec.encode("The Times 03/Jan/2009 Chancellor on the brink of second bailout for banks."),
        contentType: "text/plain;charset=utf-8"
      }),
    ];
    // let inscriptions = Array(1000).fill().map(() => 
    //   new Inscription({
    //     delegate: "d386e79a0c7639805c6a63eb0d1c3e5a616c9dc8cf0dd0691e7d5440e6a175a8i2",
    //     postage: 330,
    //     contentType: "text/plain;charset=utf-8"
    //   })
    // );

    let [dummyRevealTransaction, estRevealVSize] = getRevealTransaction(inscriptions, wallet.ordinalsAddress, revealPrivateKey, "0".repeat(64), 0);
    let [commitPsbt, estimatedRevealFee ]= await getCommitTransaction(inscriptions, wallet.paymentAddress, wallet.paymentPublicKey, revealPrivateKey, estRevealVSize);
    let signedCommitPsbt = await wallet.signPsbt(commitPsbt); 
    let commitTx = signedCommitPsbt.extractTransaction();
    let commitTxId = commitTx.getId();
    console.log("Actual commit vsize", commitTx.virtualSize());
    let [revealTransaction, revealVSize] = getRevealTransaction(inscriptions, wallet.ordinalsAddress, revealPrivateKey, commitTxId, estimatedRevealFee);
    let pushedCommitTx = await broadcastTx(commitTx.toHex());
    //await new Promise(resolve => setTimeout(resolve, 2500));
    let pushedRevealTx = await broadcastTx(Tx.encode(revealTransaction).hex);
    console.log(pushedCommitTx, pushedRevealTx);
  }

  const getRevealScript = (inscriptions, revealPublicKey) => {
    let script = [revealPublicKey, 'OP_CHECKSIG'];
    let running_postage = 0;
    for (let i = 0; i < inscriptions.length; i++) {
      let inscription = inscriptions[i];
      if (i>0) {
        inscription.pointer = running_postage;
      }
      const inscriptionScript = inscription.getInscriptionScript();
      script.push(...inscriptionScript);
      running_postage += inscription.postage;
    }
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

    let outputs = inscriptions.map((inscription) => ({
      value: inscription.postage,
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
    const commitAddress = Address.p2tr.fromPubKey(tRevealPublicKey, network);

    const paymentAddressScript = bitcoin.address.toOutputScript(paymentAddress, NETWORKS[network].bitcoinjs);
    const paymentAddressType = getAddressType(paymentAddressScript, paymentPublicKey);
    console.log(paymentAddressType);

    let feeRate = await getRecommendedFees();
    let estimatedCommitFeeForHeaderAndOutputs = (10.5 + 2 * 43) * feeRate; //tx header 10.5 vBytes, 2 taproot outputs 43 vBytes each - input vB handled in selection
    let total_postage = inscriptions.reduce((acc, inscription) => acc + inscription.postage, 0);
    let estimatedRevealFee = Math.ceil(revealVSize * feeRate + total_postage);

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

    const psbt = new bitcoin.Psbt({ network: NETWORKS[network].bitcoinjs });
    
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
            pubkey: Buffer.from(paymentPublicKey, 'hex'),
            network: NETWORKS[network].bitcoinjs
          });
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: paymentAddressScript,
              value: utxo.value
            },
            redeemScript: p2wpkh.output,
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
        address: paymentAddress,
        value: change
      });
    }

    return [psbt, estimatedRevealFee];

  }

  async function broadcastTx(txHex) {
    const url = `https://mempool.space/${NETWORKS[network].mempool}api/tx`;
  
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
    const url = `https://mempool.space/${NETWORKS[network].mempool}api/v1/txs/package?maxfeerate=100`;

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
    let fees = await fetch(`https://mempool.space/${NETWORKS[network].mempool}api/v1/fees/recommended`);
    let feesJson = await fees.json();
    let fastestFee = feesJson.fastestFee;
    return fastestFee;
  }

  const getConfirmedCardinalUtxos = async(address) => {
    if (network === 'mainnet') {
      let cardinalUtxos = await fetch(`https://blue.vermilion.place/ord_api/outputs/${address}?type=cardinal`);
      console.log(cardinalUtxos);
      //let cardinalUtxosJson = await cardinalUtxos.json();
      //console.log(cardinalUtxosJson);
    }

    let utxos = await fetch(`https://mempool.space/${NETWORKS[network].mempool}api/address/${address}/utxo`);
    let utxosJson = await utxos.json();
    console.log(utxosJson);
    let confirmedUtxos = utxosJson.filter(utxo => utxo.status.confirmed == true);
    confirmedUtxos = confirmedUtxos.filter(utxo => utxo.value > 1000);
    console.log(confirmedUtxos);
    return confirmedUtxos;
  }

  const getTxData = async(txId) => {
    let txData = await fetch(`https://mempool.space/${NETWORKS[network].mempool}api/tx/${txId}/hex`);
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
    let selected = [];
    let totalInput = 0;
    for (let i = 0; i < utxos.length; i++) {
      selected.push(utxos[i]);
      totalInput += utxos[i].effectiveValue;
      if (totalInput >= targetAmount) {
        return selected;
      }
    }

    throw new Error("Insufficient funds");
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
        network: NETWORKS[network].bitcoinjs
      })

      // Create pubkeyhash from pubkey
      const pubkeyHash = bitcoin.crypto.hash160(Buffer.from(publicKey, 'hex'))

      // Create the witness program (OP_0 <pubkeyhash>) that would be wrapped inside P2SH for this pubkey
      const p2wpkh = bitcoin.payments.p2wpkh({
        hash: pubkeyHash,
        network: NETWORKS[network].bitcoinjs
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
      {!isConnected ? (
        <button onClick={() => setIsModalOpen(true)}>Connect Wallet</button>
      ) : (
        <div>
          <div className="address-display">
            <div><strong>Payment Address:</strong> {wallet?.paymentAddress}</div>
            <div><strong>Ordinals Address:</strong> {wallet?.ordinalsAddress}</div>
          </div>
          
          <button onClick={() => createInscriptionProper()}>Create Inscription</button>
          <button onClick={() => disconnectWallet()}>Disconnect Wallet</button>
        </div>
      )}

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      >
        {window.unisat ? <button onClick={() => connectWallet('unisat')}>Connect Unisat</button> : <></>}
        {window.XverseProviders?.BitcoinProvider ? <button onClick={() => connectWallet('xverse')}>Connect Xverse</button> : <></>}
        {window.LeatherProvider ? <button onClick={() => connectWallet('leather')}>Connect Leather</button> : <></>}
        {window.magicEden ? <button onClick={() => connectWallet('magiceden')}>Connect Magic Eden</button> : <></>}
        {window.okxwallet ? <button onClick={() => connectWallet('okx')}>Connect Okx</button> : <></>}
        {window.phantom ? <button onClick={() => connectWallet('phantom')}>Connect Phantom</button> : <></>}
        {window.oyl ? <button onClick={() => connectWallet('oyl')}>Connect Oyl</button> : <></>}
      </Modal>

    </>
  )
}

const Modal = ({ isOpen, onClose, children }) => {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [isOpen]);

  return (
    <dialog ref={dialogRef}>
      {children}
      <button onClick={onClose}>Close</button>
    </dialog>
  );
};

export default App

//TODO: Backup Reveal Tx
//TODO: Use taproot address where possible
//TODO: Scan for ordinals and runes