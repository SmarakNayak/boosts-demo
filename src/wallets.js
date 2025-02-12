import * as bitcoin from 'bitcoinjs-lib'

export const unisat = {
  walletType: 'unisat',
  network: bitcoin.networks.testnet,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.unisat) throw new Error('Unisat not installed');
  },
  async connect() {
    this.windowCheck();
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
  network: bitcoin.networks.testnet,
  paymentAddress: null,
  ordinalsAddress: null,
  paymentPublicKey: null,
  ordinalsPublicKey: null,

  windowCheck() {
    if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse not installed');
  },
  async connect() {
    this.windowCheck();
    const response = await window.XverseProviders.BitcoinProvider.request("wallet_connect", {
      addresses: ['payment', 'ordinals'],
      message: 'Connect to Vermilion dot place plz'
    });
    const accounts = response.result.addresses;
    const paymentAccount = accounts.find(address => address.purpose === 'payment');
    const ordinalsAccount = accounts.find(address => address.purpose === 'ordinals');
    this.paymentAddress = paymentAccount.address;
    this.ordinalsAddress = ordinalsAccount.address;
    this.paymentPublicKey = paymentAccount.publicKey;
    this.ordinalsPublicKey = ordinalsAccount.publicKey;

    return {
      paymentAddress: paymentAccount.address,
      ordinalsAddress: ordinalsAccount.address,
      paymentPublicKey: paymentAccount.publicKey,
      ordinalsPublicKey: ordinalsAccount.publicKey,
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
      console.log(inputAddress);
      
      if (inputAddress === this.paymentAddress || inputAddress === this.ordinalsAddress) {
        inputsToSign[inputAddress].push(inputIndex);
      }
    });
    console.log(inputsToSign);

    let psbtBase64= psbt.toBase64();
    console.log(psbtBase64);
    let response = await window.XverseProviders.BitcoinProvider.request("signPsbt", {
      psbt: psbtBase64,
      signInputs: inputsToSign,
      broadcast: false
    });
    if (response.error) throw new Error(response.error.message);
    console.log(response);
    console.log(response.result.psbt === psbtBase64);
    let signedPsbt = bitcoin.Psbt.fromBase64(response.result.psbt, { network: this.network });
    let finalizedPsbt = signedPsbt.finalizeAllInputs();
    return finalizedPsbt;
  }
}