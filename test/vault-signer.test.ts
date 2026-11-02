import { expect } from 'chai';
import {
  AbiCoder,
  Transaction,
  getAddress,
} from 'ethers';
import { LacchainProvider } from '@lacchain/gas-model-provider';
import {
  VaultConfig,
  VaultLnetSigner,
  vaultGetAccountAddress,
} from '../vault-lnet-signer';

// `hardhat test` carga hardhat.config.ts, que importa dotenv/config: el .env ya
// está en process.env. Una variable exportada en la shell tiene prioridad.
const BAO_ADDR = process.env.BAO_ADDR || 'http://127.0.0.1:8200';
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BAO_ADDR);

// La cuenta que se prueba es la misma que usan los tasks: DEPLOYER_ADDRESS.
// Sin ella, en el POC local se cae a la Hardhat account #0, que es la que se
// importa en el bao de docker (github.com/LACNetNetworks/openbao-lnet).
const HARDHAT_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EXPECTED_ADDR = process.env.DEPLOYER_ADDRESS || (IS_LOCAL ? HARDHAT_ACCOUNT_0 : '');

// El token 'root' por defecto solo existe en el bao de docker (modo dev). En
// producción no hay root: hace falta un token ethsign-signer.
const BAO_TOKEN = process.env.BAO_TOKEN || (IS_LOCAL ? 'root' : '');

const cfg: VaultConfig = {
  addr: BAO_ADDR,
  token: BAO_TOKEN,
  mount: process.env.BAO_MOUNT || 'ethereum',
};

const NODE_ADDRESS = process.env.NODE_ADDRESS || '0xd00e6624a73f88b39f82ab34e8bf2b4d226fd768';
const EXPIRATION = 1893456000; // fijo para aserciones deterministas

// La tx de prueba se firma de verdad con la cuenta real. Con gasPrice 0 y el
// gas model de LNet, una tx firmada es enviable por cualquiera que la tenga, así
// que se usa un nonce que la cuenta nunca va a alcanzar: la firma queda
// inutilizable en la red. (El test nunca la envía.)
const UNREACHABLE_NONCE = 4_294_967_295; // 2^32 - 1

async function baoReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${cfg.addr}/v1/sys/health`); // no requiere token
    return r.ok || r.status === 429 || r.status === 501; // health devuelve códigos "ok" raros
  } catch {
    return false;
  }
}

describe('VaultLnetSigner contra OpenBao + plugin secp256k1', function () {
  this.timeout(30_000);

  before(async function () {
    const missing = [!EXPECTED_ADDR && 'DEPLOYER_ADDRESS', !cfg.token && 'BAO_TOKEN'].filter(Boolean);
    if (missing.length) {
      console.warn(
        `\n  ⚠️  ${missing.length > 1 ? 'Faltan' : 'Falta'} ${missing.join(' y ')} ` +
          `para probar contra ${cfg.addr}.\n` +
          '      En producción no hay root token: exportá uno ethsign-signer\n' +
          '      (ver README, "Token de OpenBao en producción").\n',
      );
      this.skip();
    }
    if (!(await baoReachable())) {
      console.warn(
        '\n  ⚠️  OpenBao no accesible — levántalo desde:\n' +
          '      https://github.com/LACNetNetworks/openbao-lnet\n',
      );
      this.skip();
    }
  });

  it('el bao tiene una cuenta para la address esperada', async () => {
    const addr = await vaultGetAccountAddress(cfg, EXPECTED_ADDR);
    expect(getAddress(addr)).to.equal(getAddress(EXPECTED_ADDR));
  });

  it('firma una tx y el from recuperado coincide con la clave del bao', async () => {
    const provider = new LacchainProvider('http://127.0.0.1:1'); // no se usa
    const signer = new VaultLnetSigner(
      cfg,
      EXPECTED_ADDR,
      provider,
      NODE_ADDRESS,
      EXPIRATION,
    );

    // tx totalmente poblada -> signTransaction no toca el provider
    const tx = {
      to: '0x1111111111111111111111111111111111111111',
      nonce: UNREACHABLE_NONCE,
      gasLimit: 100_000n,
      gasPrice: 0,
      value: 0n,
      data: '0x60fe47b1000000000000000000000000000000000000000000000000000000000000002a',
      type: 0,
    };

    const raw = await signer.signTransaction(tx);
    const parsed = Transaction.from(raw);

    // 1) Recuperación: el firmante es la clave del bao
    expect(getAddress(parsed.from!)).to.equal(getAddress(EXPECTED_ADDR));

    // 2) Gas model: chainId 0
    expect(parsed.chainId).to.equal(0n);

    // 3) Gas model: data lleva nodeAddress + expiration al final
    const suffix = AbiCoder.defaultAbiCoder()
      .encode(['address', 'uint256'], [NODE_ADDRESS, EXPIRATION])
      .substring(2);
    expect(parsed.data.endsWith(suffix)).to.equal(true);

    // 4) el plugin firmó exactamente el nonce pedido
    expect(parsed.nonce).to.equal(UNREACHABLE_NONCE);

    // 5) low-s (EIP-2)
    const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    expect(BigInt(parsed.signature!.s) <= N / 2n).to.equal(true);
  });
});
