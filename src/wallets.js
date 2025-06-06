//overall philosophy: we want to take as little information from the wallets as possible
//and do the rest ourselves. If we expect too much from the wallets, we will have compatibility
//issues with wallets that don't support the features we want. We also want to avoid
//having to write a lot of code for each wallet, so we want to keep the code as simple as possible.
import * as bitcoin from 'bitcoinjs-lib';
import { isP2PKH, isP2SHScript, isP2WPKH, isP2TR } from 'bitcoinjs-lib/src/psbt/psbtutils';
import { toXOnly } from 'bitcoinjs-lib/src/psbt/bip371';
import * as jsontokens from 'jsontokens';
import { NETWORKS, getNetworksFromAddress } from './networks';

class Wallet {
  constructor(walletType, supportsCustomAddressSigning = false, supportsKeyPathSigning = false) {
    this.walletType = walletType;
    // allows for signing of any custom p2tr address even if not the standard p2tr
    this.supportsCustomAddressSigning = supportsCustomAddressSigning;
    // allows for signing of custom p2tr addresses with internal key tweaked by merkle root of p2tr script
    this.supportsKeyPathSigning = supportsKeyPathSigning;
    this.network = null;
    this.paymentAddress = null;
    this.ordinalsAddress = null;
    this.paymentPublicKey = null;
    this.ordinalsPublicKey = null;
    this._accountChangedListener = null;
  }

  windowCheck() {
    throw new Error('windowCheck must be implemented by subclass');
  }

  async connect(network) {
    throw new Error('connect must be implemented by subclass');
  }

  async getNetwork() {
    throw new Error('getNetwork must be implemented by subclass');
  }

  async switchNetwork(network) {
    throw new Error('switchNetwork must be implemented by subclass');
  }

  async signPsbt(psbt, signingIndexes = null) {
    throw new Error('signPsbt must be implemented by subclass');
  }

  async signPsbts(psbtArray, signingIndexesArray) {
    // Default implementation signs each PSBT one at a time
    this.windowCheck();
    let signedPsbts = []
    for (let i = 0; i < psbtArray.length; i++) {
      let signedPsbt = await this.signPsbt(psbtArray[i], signingIndexesArray[i]);
      signedPsbts.push(signedPsbt);
    }
    return signedPsbts;
  }

  async setupAccountChangeListener(callback) {
    console.log(`${this.walletType} does not support account change listener by default`);
  }

  async removeAccountChangeListener() {
    // Default implementation does nothing
  }

  getAccountInfo() {
    return {
      paymentAddress: this.paymentAddress,
      ordinalsAddress: this.ordinalsAddress,
      paymentPublicKey: this.paymentPublicKey,
      ordinalsPublicKey: this.ordinalsPublicKey
    };
  }

  handleDisconnect(callback) {
    console.log("Wallet disconnected or empty address received");
    this.paymentAddress = null;
    this.ordinalsAddress = null;
    this.paymentPublicKey = null;
    this.ordinalsPublicKey = null;
    callback({ ...this.getAccountInfo(), disconnected: true });
    this.removeAccountChangeListener();
  }

  getInputAddress(input) {
    if (!this.network) throw new Error('Network not set');
    if (input.nonWitnessUtxo) {
      const tx = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
      return bitcoin.address.fromOutputScript(
        tx.outs[input.index].script,
        NETWORKS[this.network].bitcoinjs
      );
    } else if (input.witnessUtxo) {
      return bitcoin.address.fromOutputScript(
        input.witnessUtxo.script,
        NETWORKS[this.network].bitcoinjs
      );
    }
    throw new Error('Malformed PSBT: input is missing nonWitnessUtxo or witnessUtxo');
  }

  getInputsToSignGroupedNameless(psbt, signingIndexes = null) {
    const inputsToSign = { [this.ordinalsAddress]: [], [this.paymentAddress]: [] };
    if (signingIndexes) {
      signingIndexes.forEach(idx => {
        if (idx.address === this.paymentAddress) inputsToSign[this.paymentAddress].push(idx.index);
        if (idx.address === this.ordinalsAddress) inputsToSign[this.ordinalsAddress].push(idx.index);
      });
    } else {
      psbt.data.inputs.forEach((input, i) => {
        const address = this.getInputAddress(input);
        if (address === this.paymentAddress || address === this.ordinalsAddress) {
          inputsToSign[address].push(i);
        }
      });
    }
    return inputsToSign;
  }

  getInputsToSignGrouped(psbt, signingIndexes = null) {
    const inputsToSign = this.getInputsToSignGroupedNameless(psbt, signingIndexes);
    return Object.entries(inputsToSign).map(([address, signingIndexes]) => ({
      address,
      signingIndexes
    }));
  }

  hasSignableTweakedTaproot() {
    if (!this.supportsCustomAddressSigning) return false;
    const paymentAddressScript = bitcoin.address.toOutputScript(this.paymentAddress, NETWORKS[this.network].bitcoinjs);
    const ordinalsAddressScript = bitcoin.address.toOutputScript(this.ordinalsAddress, NETWORKS[this.network].bitcoinjs);
    return isP2TR(paymentAddressScript) || isP2TR(ordinalsAddressScript);
  }

  getInscriptionCreationMethod() {
    const paymentAddressScript = bitcoin.address.toOutputScript(this.paymentAddress, NETWORKS[this.network].bitcoinjs);
    const ordinalsAddressScript = bitcoin.address.toOutputScript(this.ordinalsAddress, NETWORKS[this.network].bitcoinjs);
    // no taproot so we have to use an ephemeral key (non-custodial)
    if (!(isP2TR(paymentAddressScript) || isP2TR(ordinalsAddressScript))) return 'ephemeral';
    // has taproot but can't sign reveal, so sign using ephemeral script path, whilst maintaining custody via wallet key path
    if (!this.supportsCustomAddressSigning) return 'ephemeral_with_wallet_key_path';
    // has taproot and can sign reveal, payment address is p2wpkh/p2tr, so we can extract commit tx_id and sign both txs at once
    if (isP2TR(paymentAddressScript) || isP2WPKH(paymentAddressScript)) return 'wallet_one_sign';
    // has taproot and can sign reveal, but legacy/nested payment address, so we can't extract commit tx_id before signing
    return 'wallet_two_sign';
  }

  getTaproot() {
    let paymentAddressScript = bitcoin.address.toOutputScript(this.paymentAddress, NETWORKS[this.network].bitcoinjs);
    let ordinalsAddressScript = bitcoin.address.toOutputScript(this.ordinalsAddress, NETWORKS[this.network].bitcoinjs);
    if (isP2TR(ordinalsAddressScript)) {
      // remove first byte of public key if 33 bytes to get x-only
      let xonlyInternalKey = this.ordinalsPublicKey;
      if (xonlyInternalKey.length === 66) {
        xonlyInternalKey = xonlyInternalKey.slice(2);
      }
      let tweakedTaproot = bitcoin.payments.p2tr({
        internalPubkey: toXOnly(Buffer.from(xonlyInternalKey, 'hex')),
        network: NETWORKS[this.network].bitcoinjs
      }); 

      return tweakedTaproot;
    }

    if (isP2TR(paymentAddressScript)) {
      let xonlyInternalKey = this.paymentPublicKey;
      if (xonlyInternalKey.length === 66) {
        xonlyInternalKey = xonlyInternalKey.slice(2);
      }
      let tweakedTaproot = bitcoin.payments.p2tr({
        internalPubkey: toXOnly(Buffer.from(xonlyInternalKey, 'hex')),
        network: NETWORKS[this.network].bitcoinjs
      });
      return tweakedTaproot;
    }
  }
}

class UnisatWallet extends Wallet {
  constructor() {
    super('unisat', true, false); //supports custom addresses, but not custom key path signing
  }

  windowCheck() {
    if (!window.unisat) throw new Error('Unisat not installed');
  }

  async connect(network) {
    this.windowCheck();
    const chain = await window.unisat.getChain();
    if (chain.enum !== NETWORKS[network].unisat) {
      try {
        await window.unisat.switchChain(NETWORKS[network].unisat);
      } catch (error) {
        throw new Error('Could not switch to the specified network');
      }
    }
    
    const accounts = await window.unisat.requestAccounts();
    const publicKey = await window.unisat.getPublicKey();
    this.network = network;
    this.paymentAddress = accounts[0];
    this.ordinalsAddress = accounts[0];
    this.paymentPublicKey = publicKey;
    this.ordinalsPublicKey = publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    this.windowCheck();
    const chain = await window.unisat.getChain();
    return chain.enum;
  }

  async switchNetwork(network) {
    this.windowCheck();
    await window.unisat.switchChain(network);
    this.network = network;
  }

  async signPsbt(psbt, signingIndexes = null) {
    this.windowCheck();
    const psbtHex = psbt.toHex();
    let signedPsbtHex;
    if (signingIndexes === null) {
      signedPsbtHex = await window.unisat.signPsbt(psbtHex);
    } else {
      let unisatOptions = {
        autoFinalized: true,
        toSignInputs: signingIndexes
      }
      signedPsbtHex = await window.unisat.signPsbt(psbtHex, unisatOptions);
    }
    return bitcoin.Psbt.fromHex(signedPsbtHex);
  }

  async signPsbts(psbtArray, signingIndexesArray) {
    this.windowCheck();
    const psbtHexs = psbtArray.map(psbt => psbt.toHex());
    const unisatOptions = signingIndexesArray.map(signingIndexes => ({
      toSignInputs: signingIndexes,
      autoFinalized: false
    }));
    const signedPsbtHexs = await window.unisat.signPsbts(psbtHexs, unisatOptions);
    const psbts = signedPsbtHexs.map(hex => bitcoin.Psbt.fromHex(hex));
    const finalizedPsbts = psbts.map(psbt => psbt.finalizeAllInputs());
    return finalizedPsbts;
  }

  async setupAccountChangeListener(callback) {
    this.windowCheck();
    this._accountChangedListener = async (accounts) => {
      if (accounts.length === 0) {
        this.handleDisconnect(callback);
        return;
      }
      const publicKey = await window.unisat.getPublicKey();
      this.paymentAddress = accounts[0];
      this.ordinalsAddress = accounts[0];
      this.paymentPublicKey = publicKey;
      this.ordinalsPublicKey = publicKey;
      callback(this.getAccountInfo());
    };
    window.unisat.on('accountsChanged', this._accountChangedListener);
  }

  async removeAccountChangeListener() {
    this.windowCheck();
    if (this._accountChangedListener) {
      window.unisat.removeListener('accountsChanged', this._accountChangedListener);
      this._accountChangedListener = null;
    }
  }
}

class XverseWallet extends Wallet {
  constructor() {
    super('xverse', true, true); //supports custom addresses and custom key path signing
  }

  windowCheck() {
    if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse not installed');
  }

  async connect(network) {
    this.windowCheck();
    const response = await window.XverseProviders.BitcoinProvider.request("wallet_connect", {
      addresses: ['payment', 'ordinals'],
      message: 'Connect to Vermilion dot place plz'
    });
    const accounts = response.result.addresses;
    const payment = accounts.find(a => a.purpose === 'payment');
    const ordinals = accounts.find(a => a.purpose === 'ordinals');

    if (await this.getNetwork() !== NETWORKS[network].xverse) {
      throw new Error('Connected to wrong network, please switch to ' + network);
    }
    
    this.network = network;
    this.paymentAddress = payment.address;
    this.ordinalsAddress = ordinals.address;
    this.paymentPublicKey = payment.publicKey;
    this.ordinalsPublicKey = ordinals.publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    this.windowCheck();
    const res = await window.XverseProviders.BitcoinProvider.request('wallet_getNetwork', null);
    if (res.status === 'error') throw new Error(res.error);
    return res.result.bitcoin.name;
  }

  async switchNetwork(network) {
    throw new Error('Xverse does not support network switching');
  }

  async signPsbt(psbt, signingIndexes = null) {
    this.windowCheck();
    const inputsToSign = this.getInputsToSignGroupedNameless(psbt, signingIndexes);
    const psbtBase64 = psbt.toBase64();
    console.log('Signing PSBT with Xverse:', psbtBase64, inputsToSign);
    const response = await window.XverseProviders.BitcoinProvider.request("signPsbt", {
      psbt: psbtBase64,
      signInputs: inputsToSign,
      broadcast: false
    });
    if (response.error) throw new Error(response.error.message);
    const signedPsbt = bitcoin.Psbt.fromBase64(response.result.psbt);
    if (signedPsbt.data.inputs[0].tapKeySig && signedPsbt.data.inputs[0].tapScriptSig) { // hacky af
      delete signedPsbt.data.inputs[0].tapKeySig;
    }
    let finalizedPsbt = signedPsbt.finalizeAllInputs();
    return finalizedPsbt;
  }

  async signPsbts(psbtArray, signingIndexesArray) {
    this.windowCheck();
    const psbts = psbtArray.map((psbt, i) => ({
      psbtBase64: psbt.toBase64(),
      inputsToSign: this.getInputsToSignGroupedNameless(psbt, signingIndexesArray[i]),
      broadcast: false
    }));
    // let payload = {
    //   network: { type: NETWORKS[this.network].xverse },
    //   message: 'Sign these transactions plz',
    //   psbts
    // };
    // let request = jsontokens.createUnsecuredToken(payload);
    const response = await window.XverseProviders.BitcoinProvider.request("signMultipleTransactions", {
      payload: {
        network: { type: NETWORKS[this.network].xverse },
        message: "Sign these transactions plz",
        psbts
      }
    });

    if (response.error){
      if (response.error.message.includes('is not supported')) {
        console.log('Xverse does not support signing multiple PSBTs at once, falling back to single signPsbt calls');
        let signedPsbts = []
        for (let i = 0; i < psbtArray.length; i++) {
          let signedPsbt = await this.signPsbt(psbtArray[i], signingIndexesArray[i]);
          signedPsbts.push(signedPsbt);
        }
        return signedPsbts;
      }
      throw error;
    }

    return response.result.map(r => bitcoin.Psbt.fromBase64(r.psbt).finalizeAllInputs());
  }

  async setupAccountChangeListener(callback) {
    this._accountChangedListener = window.XverseProviders.BitcoinProvider.addListener('accountChange', async () => {
      this.handleDisconnect(callback);
    });
  }

  async removeAccountChangeListener() {
    if (this._accountChangedListener) {
      this._accountChangedListener();
      this._accountChangedListener = null;
    }
  }
}

class LeatherWallet extends Wallet {
  constructor() {
    super('leather', false, false); // Error: Can not finalize taproot input #0. No tapleaf script signature provided.
  }

  windowCheck() {
    if (!window.LeatherProvider) throw new Error('Leather not installed');
  }

  async connect(network) {
    this.windowCheck();
    const response = await window.LeatherProvider.request('getAddresses');
    const payment = response.result.addresses.find(a => a.type === 'p2wpkh');
    const ordinals = response.result.addresses.find(a => a.type === 'p2tr');
    
    if (!getNetworksFromAddress(payment.address).includes(network)) {
      throw new Error('Connected to wrong network, please switch to ' + network);
    }
    
    this.network = network;
    this.paymentAddress = payment.address;
    this.ordinalsAddress = ordinals.address;
    this.paymentPublicKey = payment.publicKey;
    this.ordinalsPublicKey = ordinals.publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    throw new Error('Leather does not support getNetwork');
  }

  async switchNetwork(network) {
    throw new Error('Leather does not support network switching');
  }

  async signPsbt(psbt, signingIndexes = null) {
    this.windowCheck();
    const requestParams = { 
      hex: psbt.toHex(),
      ...(signingIndexes && { signAtIndex: signingIndexes.map(idx => idx.index) })
    };
    const response = await window.LeatherProvider.request('signPsbt', requestParams);
    if (response.error) throw new Error(response.error.message);
    const signedPsbt = bitcoin.Psbt.fromHex(response.result.hex);
    return signedPsbt.finalizeAllInputs();
  }

}

class OkxWallet extends Wallet {
  constructor() {
    super('okx', true, true); //supports custom addresses and custom key path signing
    this._provider = null;
  }

  windowCheck() {
    if (!window.okxwallet) throw new Error('OKX not installed');
  }

  async connect(network) {
    this.windowCheck();
    let response;
    if (network === 'mainnet') {
      this._provider = window.okxwallet.bitcoin;
    } else if (network === 'testnet') {
      this._provider = window.okxwallet.bitcoinTestnet;
    } else if (network === 'signet') {
      this._provider = window.okxwallet.bitcoinSignet;
    }  else {
      throw new Error('OKX only supports mainnet, testnet and signet');
    }

    response = await this._provider.connect();
    
    this.network = network;
    this.paymentAddress = response.address;
    this.ordinalsAddress = response.address;
    this.paymentPublicKey = response.publicKey;
    this.ordinalsPublicKey = response.publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    this.windowCheck();
    return this.network;
  }

  async switchNetwork(network) {
    this.windowCheck();
    await this.connect(network);
  }

  async signPsbt(psbt, signingIndexes = null) {
    this.windowCheck();
    const provider = this._provider;
    let signedPsbtHex;
    if (signingIndexes === null) {
      signedPsbtHex = await provider.signPsbt(psbt.toHex());
    } else {
      let okxOptions = {
        autoFinalized: true,
        toSignInputs: signingIndexes
      }
      signedPsbtHex = await provider.signPsbt(psbt.toHex(), okxOptions);
    }
    return bitcoin.Psbt.fromHex(signedPsbtHex);
  }

  async signPsbts(psbtArray, signingIndexesArray) {
    this.windowCheck();
    const provider = this._provider;
    const psbtHexs = psbtArray.map(psbt => psbt.toHex());
    const options = signingIndexesArray.map(signingIndexes => ({
      toSignInputs: signingIndexes,
      autoFinalized: true
    }));
    const signedPsbtHexs = await provider.signPsbts(psbtHexs, options);
    return signedPsbtHexs.map(hex => bitcoin.Psbt.fromHex(hex));
  }

  async setupAccountChangeListener(callback) {
    this.windowCheck();
    this._accountChangedListener = async (addressInfo) => {
      if (addressInfo === null) {
        this.handleDisconnect(callback);
        return;
      }
      this.paymentAddress = addressInfo.address;
      this.ordinalsAddress = addressInfo.address;
      this.paymentPublicKey = addressInfo.publicKey;
      this.ordinalsPublicKey = addressInfo.publicKey;
      callback(this.getAccountInfo());
    };
    const provider = this._provider;
    provider.on('accountChanged', this._accountChangedListener);
  }

  async removeAccountChangeListener() {
    this.windowCheck();
    if (this._accountChangedListener) {
      const provider = this._provider;
      provider.removeListener('accountChanged', this._accountChangedListener);
      this._accountChangedListener = null;
    }
  }
}

class MagicEdenWallet extends Wallet {
  constructor() {
    super('magiceden', true, true); //assumed, need to check on mainnet
  }

  windowCheck() {
    if (!window.magicEden?.bitcoin) throw new Error('MagicEden not installed');
  }

  async connect(network) {
    this.windowCheck();
    if (network !== 'mainnet') throw new Error('Magiceden only supports mainnet');
    this.network = network;
    const payload = { purposes: ['payment', 'ordinals'] };
    const request = jsontokens.createUnsecuredToken(payload);
    const response = await window.magicEden.bitcoin.connect(request);
    const accounts = response.addresses;
    const payment = accounts.find(a => a.purpose === 'payment');
    const ordinals = accounts.find(a => a.purpose === 'ordinals');
    
    this.paymentAddress = payment.address;
    this.ordinalsAddress = ordinals.address;
    this.paymentPublicKey = payment.publicKey;
    this.ordinalsPublicKey = ordinals.publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    throw new Error('MagicEden does not support getNetwork');
  }

  async switchNetwork(network) {
    throw new Error('MagicEden does not support network switching');
  }

  async signPsbt(psbt, signingIndexes = null) {
    this.windowCheck();
    const inputsToSign = this.getInputsToSignGrouped(psbt, signingIndexes);
    const psbtBase64 = psbt.toBase64();
    const payload = {
      network: { type: 'Mainnet' },
      psbtBase64,
      broadcast: false,
      inputsToSign
    };
    const request = jsontokens.createUnsecuredToken(payload);
    const response = await window.magicEden.bitcoin.signPsbt(request);
    if (response.error) throw new Error(response.error.message);
    const signedPsbt = bitcoin.Psbt.fromBase64(response.result.psbt);
    return signedPsbt.finalizeAllInputs();
  }

  async setupAccountChangeListener(callback) {
    this.windowCheck();
    this._accountChangedListener = async (accounts) => {
      const payment = accounts.find(a => a.purpose === 'payment');
      const ordinals = accounts.find(a => a.purpose === 'ordinals');
      if (this.paymentAddress === payment.address && this.ordinalsAddress === ordinals.address) {
        return;
      }
      await this.connect(this.network);
      callback(this.getAccountInfo());
    };
    window.magicEden.bitcoin.on('accountsChanged', this._accountChangedListener);
  }

  async removeAccountChangeListener() {
    this.windowCheck();
    if (this._accountChangedListener) {
      window.magicEden.bitcoin.removeListener('accountsChanged', this._accountChangedListener);
      this._accountChangedListener = null;
    }
  }
}

class PhantomWallet extends Wallet {
  constructor() {
    super('phantom', true, true); //Assumed, need to check on mainnet
  }

  windowCheck() {
    if (!window.phantom?.bitcoin) throw new Error('Phantom not installed');
  }

  async connect(network) {
    this.windowCheck();
    if (network !== 'mainnet') throw new Error('Phantom only supports mainnet');
    this.network = network;
    const accounts = await window.phantom.bitcoin.requestAccounts();
    const payment = accounts.find(a => a.purpose === 'payment');
    const ordinals = accounts.find(a => a.purpose === 'ordinals');
    
    this.paymentAddress = payment.address;
    this.ordinalsAddress = ordinals.address;
    this.paymentPublicKey = payment.publicKey;
    this.ordinalsPublicKey = ordinals.publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    this.windowCheck();
    return this.network;
  }

  async switchNetwork(network) {
    throw new Error('Phantom does not support network switching');
  }

  async signPsbt(psbt, signingIndexes = null) {
    this.windowCheck();
    const inputsToSign = this.getInputsToSignGrouped(psbt, signingIndexes);
    const psbtBytes = new Uint8Array(psbt.toBuffer());
    const signedPSBTBytes = await window.phantom.bitcoin.signPSBT(psbtBytes, {
      inputsToSign,
      broadcast: false
    });
    const signedPsbt = bitcoin.Psbt.fromBuffer(Buffer.from(signedPSBTBytes));
    return signedPsbt.finalizeAllInputs();
  }

  async setupAccountChangeListener(callback) {
    this.windowCheck();
    this._accountChangedListener = async (accounts) => {
      if (accounts.length === 0) {
        this.handleDisconnect(callback);
        return;
      }
      const payment = accounts.find(a => a.purpose === 'payment');
      const ordinals = accounts.find(a => a.purpose === 'ordinals');
      this.paymentAddress = payment.address;
      this.ordinalsAddress = ordinals.address;
      this.paymentPublicKey = payment.publicKey;
      this.ordinalsPublicKey = ordinals.publicKey;
      callback(this.getAccountInfo());
    };
    window.phantom.bitcoin.on('accountsChanged', this._accountChangedListener);
  }

  async removeAccountChangeListener() {
    this.windowCheck();
    if (this._accountChangedListener) {
      window.phantom.bitcoin.removeListener('accountsChanged', this._accountChangedListener);
      this._accountChangedListener = null;
    }
  }
}

class OylWallet extends Wallet {
  constructor() {
    super('oyl', false, false); //does not support signing custom addresses nor key path signing
  }

  windowCheck() {
    if (!window.oyl) throw new Error('Oyl not installed');
  }

  async connect(network) {
    this.windowCheck();
    if (!getNetworksFromAddress(payment.address).includes(network)) {
      throw new Error('Connected to wrong network, please switch to ' + network);
    }
    this.network = network;
    const accounts = await window.oyl.getAddresses();
    this.paymentAddress = accounts.nativeSegwit.address;
    this.ordinalsAddress = accounts.taproot.address;
    this.paymentPublicKey = accounts.nativeSegwit.publicKey;
    this.ordinalsPublicKey = accounts.taproot.publicKey;

    return this.getAccountInfo();
  }

  async getNetwork() {
    throw new Error('Oyl does not support getNetwork');
  }

  async switchNetwork(network) {
    throw new Error('Oyl does not support network switching');
  }

  async signPsbt(psbt) {
    this.windowCheck();
    const response = await window.oyl.signPsbt({
      psbt: psbt.toHex(),
      broadcast: false,
      finalize: true
    });
    return bitcoin.Psbt.fromHex(response.psbt);
  }

  async signPsbts(psbtArray, signingIndexesArray) {
    this.windowCheck();
    const response = await window.oyl.signPsbts(
      psbtArray.map(psbt => ({
        psbt: psbt.toHex(),
        broadcast: false,
        finalize: true
      }))
    );
    return response.map(signed => bitcoin.Psbt.fromHex(signed.psbt));
  }
}

export {
  UnisatWallet,
  XverseWallet,
  LeatherWallet,
  OkxWallet,
  MagicEdenWallet,
  PhantomWallet,
  OylWallet
};