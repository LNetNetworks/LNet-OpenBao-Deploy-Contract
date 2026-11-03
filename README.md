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
| `BAO_TOKEN` | Token de OpenBao. En local (docker, modo dev) es `root`; en producción, uno de vida corta con permiso de firma — ver [Desplegar en producción](#desplegar-en-producción-paso-a-paso) |
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

## Desplegar en producción (paso a paso)

En producción **no existe un token root** y **no se guarda ningún token en el
`.env`**. Cada sesión de trabajo es:

1. sacar un token de vida corta del rol `ethsign-signer`;
2. verificar que el vault custodia `DEPLOYER_ADDRESS`;
3. desplegar / interactuar con el contrato;
4. revocar el token.

### Requisitos

- `kubectl` con acceso al cluster donde corre OpenBao (`gcloud auth login` +
  `gcloud container clusters get-credentials …`), `jq` y `curl`.
- `npm install` y `npx hardhat compile` hechos.
- El `.env` completo. Además de las variables de [arriba](#variables-de-entorno),
  el login usa estas tres (los valores reales los da un operador del vault; no
  van en este repo):

| Var | Descripción |
|-----|-------------|
| `KUBE_CONTEXT` | Contexto de `kubectl` del cluster de producción |
| `SIGNER_NAMESPACE` | Namespace autorizado para el rol `ethsign-signer` |
| `SIGNER_SA` | ServiceAccount de ese namespace (default `default`) |

### Token de OpenBao en producción

El rol `ethsign-signer` sólo permite **leer cuentas y firmar transacciones**
(`/sign`): no exporta claves, no firma digests arbitrarios y no administra el
vault. El token dura **1h** y se puede renovar hasta **4h**.

```bash
# 1. Cargar el .env en la shell (BAO_ADDR, KUBE_CONTEXT, SIGNER_NAMESPACE, …)
set -a; source .env; set +a

# 2. JWT de la ServiceAccount → token de OpenBao
JWT=$(kubectl --context "$KUBE_CONTEXT" create token "${SIGNER_SA:-default}" \
  -n "$SIGNER_NAMESPACE" --duration=3600s)
export BAO_TOKEN=$(curl -s -d "{\"role\":\"ethsign-signer\",\"jwt\":\"$JWT\"}" \
  "$BAO_ADDR/v1/auth/kubernetes/login" | jq -r .auth.client_token)
unset JWT

# 3. Comprobar el token: políticas ["default","ethsign-signer"] y ttl ~3600
curl -s -H "X-Vault-Token: $BAO_TOKEN" "$BAO_ADDR/v1/auth/token/lookup-self" \
  | jq '.data | {policies, ttl}'
```

Si el paso 2 deja `BAO_TOKEN=null`, el login falló: revisar `KUBE_CONTEXT`,
`SIGNER_NAMESPACE` y que tu usuario pueda crear tokens en ese namespace.

> El token se **exporta en la shell**, no se escribe en el `.env`. `dotenv` no
> pisa una variable que ya existe en el entorno, así que Hardhat usa el token
> exportado aunque el `.env` tenga `BAO_TOKEN=` vacío.

### Verificar el deployer

```bash
npx hardhat check-deployer --network lnet
```
```
clave del bao    = 0x…
DEPLOYER_ADDRESS = 0x…
✅ Coinciden
```

Opcional: `npm test` firma una tx de prueba contra el vault (sin enviarla) y debe
dar `2 passing`.

### Desplegar

```bash
npx hardhat deploy-storage --value 42 --network lnet
```
```
🔐 Clave del bao verificada → 0x…
Desplegando Storage firmando con OpenBao...
trustedForwarder: 0x…
✅ Storage desplegado en: 0x<ADDRESS_DEL_CONTRATO>
store(42) ok — retrieve(): 42
```

Anotar la address del contrato: es la que usan `store` y `retrieve`. Cada
transacción vuelve a pedir la firma al vault con el mismo token.

### Usar el contrato

```bash
npx hardhat store    --address 0x<ADDRESS_DEL_CONTRATO> --value 123 --network lnet   # firma
npx hardhat retrieve --address 0x<ADDRESS_DEL_CONTRATO> --network lnet               # sólo lee
```

`retrieve` no necesita token: es una llamada `view` contra el RPC.

Si la sesión dura más de una hora, renovar antes de que venza (hasta 4h en total):

```bash
curl -s -X POST -H "X-Vault-Token: $BAO_TOKEN" "$BAO_ADDR/v1/auth/token/renew-self" \
  | jq '.auth.lease_duration'
```

### Revocar el token al terminar

```bash
# 1. Revocar
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "X-Vault-Token: $BAO_TOKEN" "$BAO_ADDR/v1/auth/token/revoke-self"     # → 204

# 2. Confirmar que ya no sirve
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Vault-Token: $BAO_TOKEN" "$BAO_ADDR/v1/auth/token/lookup-self"     # → 403

# 3. Sacarlo de la shell
unset BAO_TOKEN
```

Aunque vence solo en 1h, revocarlo al terminar acorta la ventana en la que un
token filtrado (historial, logs, otra terminal) sirve para firmar.

### Errores comunes

| Síntoma | Causa |
|---------|-------|
| `BAO_TOKEN=null` tras el login | Contexto o namespace equivocados, o sin permiso para `create token` |
| `403 permission denied` al firmar | Token vencido o revocado: sacar uno nuevo |
| `Signing account 0x… does not exist` | `DEPLOYER_ADDRESS` no es una cuenta de ese vault |
| `❌ NO coinciden` en `check-deployer` | `DEPLOYER_ADDRESS` mal copiada |
| El test dice `Falta BAO_TOKEN` | No se exportó el token en esta shell |

## Notas

- El check de `DEPLOYER_ADDRESS` corre automáticamente antes de cualquier task que firme
  (`deploy-storage`, `store`); aborta antes de enviar nada si no coincide.
- La `expiration` se renueva (+24h) en cada ejecución.
- En el plugin secp256k1 las cuentas se direccionan **por su address Ethereum**
  (no por un nombre de clave): por eso `DEPLOYER_ADDRESS` es a la vez el firmante y la
  ruta en el bao (`/secp/accounts/<DEPLOYER_ADDRESS>`).
