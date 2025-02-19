//overall philosophy: we want to take as little information from the wallets as possible
//and do the rest ourselves. If we expect too much from the wallets, we will have compatibility
//issues with wallets that don't support the features we want. We also want to avoid
//having to write a lot of code for each wallet, so we want to keep the code as simple as possible.

import * as bitcoin from 'bitcoinjs-lib'
import * as jsontokens from 'jsontokens'
import { NETWORKS, getNetworkFromAddress } from './networks'

export const unisat = {
  walletType: 'unisat',
  network: null,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.unisat) throw new Error('Unisat not installed');
  },
  async connect(network) {
    this.windowCheck();
    const chain = await window.unisat.getChain();
    if (chain.enum === NETWORKS[network].unisat) {
      this.network = network;
    } else {
      try {
        await window.unisat.switchChain(NETWORKS[network].unisat);
        this.network = network;
      } catch (error) {
        throw new Error('Could not switch to the specified network');
      }
    }

    const accounts = await window.unisat.requestAccounts();
    const publicKey = await window.unisat.getPublicKey();
    this.paymentAddress = accounts[0];
    this.ordinalsAddress = accounts[0];
    this.paymentPublicKey = publicKey;
    this.ordinalsPublicKey = publicKey

    return {
      paymentAddress: accounts[0],
      ordinalsAddress: accounts[0],
      paymentPublicKey: publicKey,
      ordinalsPublicKey: publicKey,
    };
  },
  async getNetwork() {
    this.windowCheck();
    let chain = await window.unisat.getChain();
    return chain.enum;
  },
  async switchNetwork(network) {
    this.windowCheck();
    await window.unisat.switchChain(network);
  },
  async signPsbt(psbt) {
    this.windowCheck();
    let psbtHex = psbt.toHex();
    let signedPsbtHex = await window.unisat.signPsbt(psbtHex);
    let signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex);
    return signedPsbt;
  }
}

export const xverse = {
  walletType: 'xverse',
  network: null,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse not installed');
  },
  async connect(network) {
    this.windowCheck();
    const response = await window.XverseProviders.BitcoinProvider.request("wallet_connect", {
      addresses: ['payment', 'ordinals'],
      message: 'Connect to Vermilion dot place plz'
    });
    const accounts = response.result.addresses;
    const paymentAddress = accounts.find(address => address.purpose === 'payment');
    const ordinalsAddress = accounts.find(address => address.purpose === 'ordinals');
    if (getNetworkFromAddress(paymentAddress.address) === network) {
      this.network = network;
    } else {
      throw new Error('Connected to wrong network');
    }
    this.paymentAddress = paymentAddress.address;
    this.ordinalsAddress = ordinalsAddress.address;
    this.paymentPublicKey = paymentAddress.publicKey;
    this.ordinalsPublicKey = ordinalsAddress.publicKey;

    return {
      paymentAddress: paymentAddress.address,
      ordinalsAddress: ordinalsAddress.address,
      paymentPublicKey: paymentAddress.publicKey,
      ordinalsPublicKey: ordinalsAddress.publicKey,
    };
  },
  async getNetwork() {
    throw new Error('Xverse does not support getNetwork');
  },
  async switchNetwork(network) {
    throw new Error('Xverse does not support network switching');
  },
  async signPsbt(psbt) {
    this.windowCheck();
    let inputsToSign = { [this.ordinalsAddress]: [], [this.paymentAddress]: [] };

    psbt.data.inputs.forEach((input, inputIndex) => {
      let inputAddress;
      if (input.nonWitnessUtxo) {
        const transaction = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
        const output = transaction.outs[input.index];
        inputAddress = bitcoin.address.fromOutputScript(
          output.script,
          this.network
        );
      } else if (input.witnessUtxo) {
        inputAddress = bitcoin.address.fromOutputScript(
          input.witnessUtxo.script,
          this.network
        );
      } else {
        throw new Error('Malformed PSBT: input is missing nonWitnessUtxo or witnessUtxo');
      }
      
      if (inputAddress === this.paymentAddress || inputAddress === this.ordinalsAddress) {
        inputsToSign[inputAddress].push(inputIndex);
      }
    });

    let psbtBase64= psbt.toBase64();
    let response = await window.XverseProviders.BitcoinProvider.request("signPsbt", {
      psbt: psbtBase64,
      signInputs: inputsToSign,
      broadcast: false
    });
    if (response.error) throw new Error(response.error.message);
    let signedPsbt = bitcoin.Psbt.fromBase64(response.result.psbt);
    let finalizedPsbt = signedPsbt.finalizeAllInputs();
    return finalizedPsbt;
  }
}

export const leather = {
  walletType: 'leather',
  network: null,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.LeatherProvider) throw new Error('Leather not installed');
  },
  async connect(network) {
    this.windowCheck();
    const response = await window.LeatherProvider.request('getAddresses');
    const paymentAddress = response.result.addresses.find(address => address.type === 'p2wpkh');
    const ordinalsAddress = response.result.addresses.find(address => address.type === 'p2tr');
    if (getNetworkFromAddress(paymentAddress.address) === network) {
      this.network = network;
    } else {
      throw new Error('Connected to wrong network');
    }
    this.paymentAddress = paymentAddress.address;
    this.ordinalsAddress = ordinalsAddress.address;
    this.paymentPublicKey = paymentAddress.publicKey;
    this.ordinalsPublicKey = ordinalsAddress.publicKey;

    return {
      paymentAddress: paymentAddress.address,
      ordinalsAddress: ordinalsAddress.address,
      paymentPublicKey: paymentAddress.publicKey,
      ordinalsPublicKey: ordinalsAddress.publicKey,
    };
  },
  async getNetwork() {
    throw new Error('Leather does not support getNetwork');
  },
  async switchNetwork(network) {
    throw new Error('Leather does not support network switching');
  },
  async signPsbt(psbt) {
    this.windowCheck();
    let response = await window.LeatherProvider.request('signPsbt', { hex: psbt.toHex() });
    if (response.error) throw new Error(response.error.message);
    console.log(response);
    let signedPsbt = bitcoin.Psbt.fromHex(response.result.hex);
    let finalizedPsbt = signedPsbt.finalizeAllInputs();
    return finalizedPsbt;
  }
}

export const okx = {
  walletType: 'okx',
  network: null,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.okxwallet) throw new Error('OKX not installed');
  },
  async connect(network) {
    this.windowCheck();
    let response;
    if (network === 'mainnet') {
      response = await window.okxwallet.bitcoin.connect();
    } else if (network === 'testnet') {
      response = await window.okxwallet.bitcoinTestnet.connect();
    }
    this.network = network;
    this.paymentAddress = response.address;
    this.ordinalsAddress = response.address;
    this.paymentPublicKey = response.publicKey;
    this.ordinalsPublicKey = response.publicKey;

    return {
      paymentAddress: response.address,
      ordinalsAddress: response.address,
      paymentPublicKey: response.publicKey,
      ordinalsPublicKey: response.publicKey,
    };
  },
  async getNetwork() {
    this.windowCheck();
    return this.network;
  },
  async switchNetwork(network) {
    this.windowCheck();
    await this.connect(network);
  },
  async signPsbt(psbt) {
    this.windowCheck();
    if (this.network === 'mainnet') {
      let signedPsbtHex = await window.okxwallet.bitcoin.signPsbt(psbt.toHex());
      let signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex);
      return signedPsbt;
    } else if (this.network === 'testnet') {
      let signedPsbtHex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt.toHex());
      let signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex);
      return signedPsbt;
    }
  }
}

export const magiceden = {
  walletType: 'magiceden',
  network: null,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.magicEden.bitcoin) throw new Error('MagicEden not installed');
  },
  async connect(network) {
    this.windowCheck();
    //if (network !== 'mainnet') throw new Error('MagicEden only supports mainnet');
    this.network = network;
    let payload = {
      purposes: ['payment', 'ordinals']
    };
    let request = jsontokens.createUnsecuredToken(payload);
    let response = await window.magicEden.bitcoin.connect(request);
    const accounts = response.addresses;
    const paymentAddress = accounts.find(address => address.purpose === 'payment');
    const ordinalsAddress = accounts.find(address => address.purpose === 'ordinals');
    this.paymentAddress = paymentAddress.address;
    this.ordinalsAddress = ordinalsAddress.address;
    this.paymentPublicKey = paymentAddress.publicKey;
    this.ordinalsPublicKey = ordinalsAddress.publicKey;

    return {
      paymentAddress: paymentAddress.address,
      ordinalsAddress: ordinalsAddress.address,
      paymentPublicKey: paymentAddress.publicKey,
      ordinalsPublicKey: ordinalsAddress.publicKey,
    };
  },
  async getNetwork() {
    throw new Error('MagicEden does not support getNetwork');
  },
  async switchNetwork(network) {
    throw new Error('MagicEden does not support network switching');
  },
  async signPsbt(psbt) {
    this.windowCheck();
    let inputsToSign = [
      {
        address: this.paymentAddress,
        signingIndexes: []
      },
      {
        address: this.ordinalsAddress,
        signingIndexes: []
      }
    ];

    psbt.data.inputs.forEach((input, inputIndex) => {
      let inputAddress;
      if (input.nonWitnessUtxo) {
        const transaction = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
        const output = transaction.outs[input.index];
        inputAddress = bitcoin.address.fromOutputScript(
          output.script,
          this.network
        );
      } else if (input.witnessUtxo) {
        inputAddress = bitcoin.address.fromOutputScript(
          input.witnessUtxo.script,
          this.network
        );
      } else {
        throw new Error('Malformed PSBT: input is missing nonWitnessUtxo or witnessUtxo');
      }
      
      if (inputAddress === this.paymentAddress || inputAddress === this.ordinalsAddress) {
        inputsToSign.find(input => input.address === inputAddress).signingIndexes.push(inputIndex);
      }
    });

    let psbtBase64= psbt.toBase64();
    let payload = {
      network: {
        type: 'Mainnet',
      },
      psbtBase64: psbtBase64,
      broadcast: false,
      inputsToSign: inputsToSign
    };
    let request = jsontokens.createUnsecuredToken(payload);
    let response = await window.magicEden.bitcoin.signPsbt(request);
    if (response.error) throw new Error(response.error.message);
    let signedPsbt = bitcoin.Psbt.fromBase64(response.result.psbt);
    let finalizedPsbt = signedPsbt.finalizeAllInputs();
    return finalizedPsbt;
  }
}