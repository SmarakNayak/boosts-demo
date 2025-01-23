import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'
import * as ecc from '@cmdcode/crypto-utils'
import { Address, Signer, Tap, Tx } from '@cmdcode/tapscript'
import * as bitcoin from 'bitcoinjs-lib'
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
    let privateKeyBuffer = await generatePrivateKey();
    let privateKey = Buffer.from(privateKeyBuffer).toString('hex');
    let content = "Hello World".toString('base64');
    let mimeType = "text/plain;charset=UTF-8";
    console.log(content);
    console.log(privateKey);
    let utxos = await getConfirmedCardinalUTXOs(address);
    let lol = getCommitTx(content, mimeType, address, publicKey, privateKey);
  }

  const getCommitTx = async(content, mimeType, address, publicKey, revealPrivateKey) => {
    let contentLength = Buffer.byteLength(content);
    if (contentLength > 390_000) {
      console.log("Content too long");
    }
    let fee = await getRecommendedFees();
    let revealPublicKey = ecc.keys.get_pubkey(String(revealPrivateKey), true);
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
    const script = createInscriptionScript(revealPublicKey, content, mimeType);
    const tapleaf = Tap.encodeScript(script);
    const tpubkey = Tap.getPubKey(revealPublicKey,{target: tapleaf});
    console.log(tpubkey);
    const inscriberAddress = Address.p2tr.fromPubKey(
      tpubkey[0],
      "testnet"
    )
    console.log(inscriberAddress);
    let estimatedCommitSize = 170;
    let estimatedCommitFee = fee * estimatedCommitSize;
    let estimatedRevealFee = (contentLength * fee)/4 + 1000 + 546;
    let estimatedInscriptionFee = estimatedCommitFee + estimatedRevealFee;
    let utxos = await getConfirmedCardinalUTXOs(address);
    let selectedUtxos = selectUTXOS(utxos, estimatedInscriptionFee);
    console.log(estimatedInscriptionFee);
    console.log(selectedUtxos);

  }

  const getRecommendedFees = async() => {
    let fees = await fetch("https://mempool.space/testnet4/api/v1/fees/recommended");
    let feesJson = await fees.json();
    let fastestFee = feesJson.fastestFee;
    return fastestFee;
  }

  const getConfirmedCardinalUTXOs = async(address) => {
    // "https://ordinals.com/outputs/<address>?type=cardinal"
    let utxos = await fetch(`https://mempool.space/testnet4/api/address/${address}/utxo`);
    let utxosJson = await utxos.json();
    console.log(utxosJson);
    let confirmedUtxos = utxosJson.filter(utxo => utxo.status.confirmed);
    console.log(confirmedUtxos);
    return utxosJson;
  }

  const selectUTXOS = (utxos, targetAmount) => {
    utxos.sort((a, b) => a.value - b.value);
    
    // 1. Exact match
    for (let i = 0; i < utxos.length; i++) {
      if (utxos[i].value === targetAmount) {
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
      totalInput += utxos[i].value;
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
      if (currentSum + remainingUtxos.reduce((acc, utxo) => acc + utxo.value, 0) < targetAmount) {
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
        let newSum = currentSum + remainingUtxos[i].value;
        explore(newRemainingUtxos, newSelectedUtxos, newSum, depth + 1);
      }
    }
    explore(utxos, [], 0, 0);
    return bestSolution;
  }

  const createInscriptionScript = (revealPublicKey, content, mimeType) => {
    let ec = new TextEncoder();
    let marker = ec.encode('ord');
    let INSCRIPTION_SIZE = 546;

    let contentBuffer = Buffer.from(content, 'base64');
    const contentChunks = [];
    for (let i = 0; i < contentBuffer.length; i += 520) {
      contentChunks.push(contentBuffer.subarray(i, i + 520));
    }

    const script = [revealPublicKey, 'OP_CHECKSIG'];
    script.push('OP_0', 'OP_IF', marker, '01',ec.encode(mimeType), 'OP_0');
    script.push(...contentChunks, 'OP_ENDIF');
    return script;
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
