# LNet-OpenBao-Deploy-Contract

Despliega e interactúa con un contrato `Storage` en **lnet** firmando con
**OpenBao/Vault** (plugin secp256k1) en lugar de claves privadas locales, respetando
el modelo de gas de LNet vía `@lacchain/gas-model-provider`.

## Estructura

```
.
├── contracts/Storage.sol        # store()/retrieve()
├── lnet.params.ts               # url / nodeAddress / expirationSeconds
├── vault-lnet-signer.ts         # VaultLnetSigner + firma de la tx contra el bao (ethsign)
├── tasks/deploy-storage.ts      # tasks: check-deployer, deploy-storage, store, retrieve
├── test/vault-signer.test.ts    # test de firma contra OpenBao
├── hardhat.config.ts
├── package.json
└── tsconfig.json
```

## Instalación

```bash
npm install
cp .env.example .env   # completa los valores
npx hardhat compile
```

## Variables de entorno

| Var | Descripción |
|-----|-------------|
| `LNET_RPC` | RPC del nodo lnet |
| `NODE_ADDRESS` | Writer node que aprueba las tx (gas model) |
| `DEPLOYER_ADDRESS` | Cuenta firmante; debe coincidir con la clave del bao |
| `BAO_ADDR` | URL de OpenBao (default `http://127.0.0.1:8200`) |
| `BAO_TOKEN` | Token de OpenBao. En local (docker, modo dev) es `root`; en producción, uno de vida corta con permiso de firma — ver [Token de OpenBao en producción](#token-de-openbao-en-producción) |
| `BAO_MOUNT` | Path del plugin ethsign (default `ethereum`) |

## Tasks

### `check-deployer` — valida que `DEPLOYER_ADDRESS` == clave del bao

```bash
npx hardhat check-deployer --network lnet
```
```
clave del bao    = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEPLOYER_ADDRESS = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
✅ Coinciden
```

### `deploy-storage` — deploy + `store` inicial (firma con el bao)

`--value` es opcional (default `42`).

```bash
npx hardhat deploy-storage --value 666 --network lnet
```
```
🔐 Clave del bao verificada → 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Desplegando Storage firmando con OpenBao...
trustedForwarder: 0xEAA5420AF59305c5ecacCB38fcDe70198001d147
✅ Storage desplegado en: 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47
store(666) ok — retrieve(): 666
```

### `store` — escribir en un Storage existente (firma con el bao)

```bash
npx hardhat store --address 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47 --value 123 --network lnet
```
```
🔐 Clave del bao verificada → 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
retrieve() actual: 666
Enviando store(123) — firma con OpenBao...
✅ tx confirmada: 0x0a9f30fc8bde7216dbc4a68c8d41cccef65998df4bbd7566c878cb3c0ca87e8c
retrieve() nuevo: 123
```

### `retrieve` — leer (sólo provider, no firma ni gasta)

```bash
npx hardhat retrieve --address 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47 --network lnet
```
```
retrieve() @ 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47: 123
```

## OpenBao

[OpenBao](https://openbao.org) es un gestor de secretos open source (fork de
HashiCorp Vault) que guarda claves y las usa **sin exponerlas**: la clave privada
nunca sale del bao. Acá lo usamos como una especie de HSM en software — le pasamos
la transacción sin firmar y nos devuelve la firma, de modo que el proyecto firma
en lnet **sin manejar claves privadas locales**.

Este proyecto **no incluye** el OpenBao: se gestiona en el repo aparte
[`LACNetNetworks/openbao-lnet`](https://github.com/LACNetNetworks/openbao-lnet).
Levantá el bao desde ahí (build + `docker compose up -d`) y apuntá las variables
`BAO_ADDR` / `BAO_TOKEN` / `BAO_MOUNT` de este proyecto a esa instancia.

> **Importante:** el motor `transit` de OpenBao/Vault **no soporta secp256k1**
> (sólo curvas NIST P-256/384/521 + ed25519), así que **no sirve** para Ethereum.
> Por eso `openbao-lnet` usa el plugin `ethsign` (secp256k1), que firma la tx
> completa vía `POST /<mount>/accounts/<address>/sign` y devuelve el RLP firmado.
> El signer le pasa `chainId: "0"` para que firme legacy (Homestead, pre-EIP155),
> con el sufijo `nodeAddress + expiration` del gas model ya incluido en `data`.

```bash
# en openbao-lnet
docker compose up -d

# en este repo, contra ese bao
npm test              # corre test/vault-signer.test.ts contra el bao real
```

El test verifica, firmando contra OpenBao real:
1. el bao tiene una cuenta para la address esperada;
2. el `from` recuperado de la tx firmada coincide con la clave del bao;
3. `chainId == 0` y la `data` lleva el sufijo `nodeAddress + expiration` (gas model);
4. la firma es `low-s` (EIP-2).

El test usa la misma cuenta que los tasks (`DEPLOYER_ADDRESS`). Sin ella, y sólo
contra un bao local, cae a la Hardhat account #0 (`0xf39F…2266`), que es la que se
importa en el bao de docker. La tx de prueba se firma con un nonce inalcanzable
(`2^32-1`) y **nunca se envía**, así que la firma no sirve en la red aunque se filtre.

Si el bao no está accesible, o falta `DEPLOYER_ADDRESS` / `BAO_TOKEN` contra un bao
remoto, el test se salta (no falla) con un aviso.

## Token de OpenBao en producción

En producción **no existe un token root**, y no hay que guardar ningún token en el
`.env`. Se usa uno de vida corta (1h, renovable hasta 4h) del rol `ethsign-signer`,
que sólo permite leer cuentas y firmar transacciones (`/sign`): no exporta claves ni
firma digests arbitrarios.

Se obtiene con Kubernetes auth, a partir de una ServiceAccount de un namespace
autorizado para ese rol (pedile a un operador del vault cuál usar):

```bash
JWT=$(kubectl --context <cluster de prod> create token <service-account> -n <namespace> --duration=3600s)
export BAO_TOKEN=$(curl -s -d "{\"role\":\"ethsign-signer\",\"jwt\":\"$JWT\"}" \
  "$BAO_ADDR/v1/auth/kubernetes/login" | jq -r .auth.client_token)

npx hardhat check-deployer --network lnet   # ✅ Coinciden
npm test
```

Exportalo en la shell en vez de escribirlo en el `.env`: `dotenv` no pisa una
variable que ya existe en el entorno, así el token no queda en disco. Al terminar:

```bash
curl -s -X POST -H "X-Vault-Token: $BAO_TOKEN" "$BAO_ADDR/v1/auth/token/revoke-self"
```

## Notas

- El check de `DEPLOYER_ADDRESS` corre automáticamente antes de cualquier task que firme
  (`deploy-storage`, `store`); aborta antes de enviar nada si no coincide.
- La `expiration` se renueva (+24h) en cada ejecución.
- En el plugin secp256k1 las cuentas se direccionan **por su address Ethereum**
  (no por un nombre de clave): por eso `DEPLOYER_ADDRESS` es a la vez el firmante y la
  ruta en el bao (`/secp/accounts/<DEPLOYER_ADDRESS>`).
