# SigMap Query Context
Generated: 2026-05-24T01:29:11.771Z

## backends\qdrant.js
```
export class QdrantBackend
async initialize(settings)
if(settings.qdrant_use_cloud)
if(!response.ok)
async healthCheck()
if(!collectionId || typeof collectionId !== 'string')
if(!collectionId || typeof collectionId !== 'string')
if(parts.length >= 3 && parts[0] === 'vf')
async getSavedHashes(collectionId, settings)
function _isDimensionMismatch(errorBody)
function _warnDimensionMismatch(errorBody)
function getPluginProviderParams(settings)
function getActualCollectionId(collectionId, settings) → string
```

## backends\standard.js
```
export class StandardBackend
constructor()
async initialize(settings)
if(this.pluginAvailable)
async healthCheck()
async getSavedHashes(collectionId, settings) → object
if(!response.ok)
if(response.status === 500)
async insertVectorItems(collectionId, items, settings, abortSignal = null)
function getProviderSpecificParams(settings, isQuery = false) → object
```

## core\core-vector-api.js
```
class DynamicRateLimiter
constructor()
async execute(fn, settings) → Promise<any>
if(maxCalls <= 0)
if(this.timestamps.length >= maxCalls)
if(waitTime > 0)
export function getVectorsRequestBody(args = {}, settings) → object
export async function getAdditionalArgs(items, settings, onProgress = null) → Promise<object>
export function throwIfSourceInvalid(settings)
export async function getSavedHashes(collectionId, settings, includeMetadata = false) → Promise<number[]|{hashes:
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) → Promise<void>
export async function deleteVectorItems(collectionId, hashes, settings) → Promise<void>
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) → Promise<{ hashes: number[
export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) → Promise<Record<string, {
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) → Promise<Record<string, {
export async function purgeVectorIndex(collectionId, settings) → Promise<boolean>
export async function purgeFileVectorIndex(collectionId, settings) → Promise<void>
export async function purgeAllVectorIndexes(settings) → Promise<void>
export async function listChunks(collectionId, settings, options = {}) → Promise<{items: Array<{ha
export async function updateChunkText(collectionId, hash, newText, settings)
```

## diagnostics\infrastructure.js
```
export async function checkVectorsExtension()
export async function checkBackendEndpoints(settings)
export async function checkServerPlugin()
export async function checkPluginEndpoints()
export async function checkQdrantBackend(settings)
export async function checkQdrantDimensionMatch(settings)
export async function checkEmbeddingProvider(settings)
export function checkTransformersMemoryLimits(settings)
export function checkApiKeys(settings)
export function checkApiUrls(settings)
export async function checkProviderConnectivity(settings)
export function checkWebLlmExtension(settings)
export async function checkBananaBreadConnection(settings)
function getPluginProviderParams(settings) → object
```

## core\collection-loader.js
```
export function getCollectionFilterReason(collectionId) → string|null
export function getCollectionRegistry() → string[]
export function sanitizeHandleId(name)
export function registerCollection(collectionId)
export function getCollectionListing(settings) → Array<{ * registryKey: st
export function unregisterCollection(collectionId)
export async function deleteCollection(collectionId, settings, registryKey = null) → Promise<{success: boolean
export function clearCollectionRegistry()
export function cleanupCollectionRegistry()
export function cleanupTestCollections() → number
export async function checkPluginAvailable() → Promise<boolean>
export async function cleanupCorruptedCollections() → Promise<{purged: Array<{k
export async function discoverExistingCollections(settings) → Promise<string[]>
export async function doesChatHaveVectors(settings, overrideChatId, overrideUUID) → Promise<{hasVectors: bool
export async function loadAllCollections(settings, autoDiscover = true) → Promise<object[]>
export function isCollectionEmpty(registryKey) → boolean
function _sanitizeHandleId(name)
function getCollectionDisplayName(collectionId, metadata) → string
async function discoverViaPlugin(settings) → Promise<string[]>
async function probeCollection(collectionId, settings) → Promise<{exists: boolean,
```
