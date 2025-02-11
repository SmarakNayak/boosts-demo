import * as bitcoin from 'bitcoinjs-lib'

export const unisat = {
  walletType: 'unisat',
  mainnetString: 'BITCOIN_MAINNET',
  testnetString: 'BITCOIN_TESTNET4',
  windowCheck() {
    if (!window.unisat) throw new Error('Unisat not installed');
  },
  async connect() {
    this.windowCheck();
    const accounts = await window.unisat.requestAccounts();
    const publicKey = await window.unisat.getPublicKey();
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
  mainnetString: 'BITCOIN_MAINNET',
  testnetString: 'BITCOIN_TESTNET4',
  windowCheck() {
    if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse not installed');
  },
  async connect() {
    this.windowCheck();
    const accounts = await window.XverseProviders.BitcoinProvider.request("wallet_connect")
    const publicKey = await window.xverse.getPublicKey();
    return {
      paymentAddress: accounts[0],
      ordinalsAddress: accounts[0],
      paymentPublicKey: publicKey,
      ordinalsPublicKey: publicKey,
    };
  },
  async getNetwork() {
    this.windowCheck();
    let chain = await window.xverse.getChain();
    return chain.enum;
  },
  async switchNetwork(network) {
    this.windowCheck();
    await window.xverse.switchChain(network);
  },
  async signPsbt(psbt) {
    this.windowCheck();
    let psbtHex = psbt.toHex();
    let signedPsbtHex = await window.xverse.signPsbt(psbtHex);
    let signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex);
    return signedPsbt;
  }
}