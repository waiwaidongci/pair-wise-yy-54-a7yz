<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const mapEl = ref<HTMLDivElement>()
let map: MapLibreMap | undefined
const layers = ref({ closure: true, detour: true, ambulance: true, bus: true, adjacent: true, shared: true })

const sharedLinks = computed(() => store.links.filter((link) => link.sharedWithCorridor))

function addGeoSource(id: string, coordinates: [number, number][], color: string, width = 5, dasharray?: number[]) {
  if (!map?.isStyleLoaded()) return
  if (map.getLayer(id)) { map.removeLayer(id); map.removeSource(id) }
  map.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } } })
  map.addLayer({ id, type: 'line', source: id, paint: { 'line-color': color, 'line-width': width, 'line-opacity': .9, ...(dasharray ? { 'line-dasharray': dasharray } : {}) } })
}

function drawAll() {
  if (!map?.isStyleLoaded()) return
  // 共用路面先画（底描金），再叠加通道、绕行、围挡
  store.links.filter((link) => link.sharedWithCorridor).forEach((link, index) => {
    addGeoSource(`shared-${index}`, [link.a, link.b], '#facc15', 9)
  })
  const stage = store.selectedStage
  if (stage) addGeoSource('closure', stage.route, '#ef4444')
  store.scheme.detours.forEach((route, index) => addGeoSource(`detour-${index}`, route.coordinates, '#2563eb', 4, [2, 2]))
  addGeoSource('ambulance', store.scheme.ambulanceCorridor.coordinates, '#16a34a', 4)
  addGeoSource('bus', store.scheme.busCorridor.coordinates, '#d97706', 4, [1, 1])
  store.scheme.adjacentWorks.forEach((work, index) => addGeoSource(`adjacent-${index}`, work.occupyCoordinates, '#7c3aed', 4))
}
function toggleLayer(id: string, visible: boolean) { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none') }
function applyVisibility() {
  if (!map) return
  toggleLayer('closure', layers.value.closure)
  store.scheme.detours.forEach((_, index) => toggleLayer(`detour-${index}`, layers.value.detour))
  toggleLayer('ambulance', layers.value.ambulance)
  toggleLayer('bus', layers.value.bus)
  store.scheme.adjacentWorks.forEach((_, index) => toggleLayer(`adjacent-${index}`, layers.value.adjacent))
  store.links.filter((l) => l.sharedWithCorridor).forEach((_, index) => toggleLayer(`shared-${index}`, layers.value.shared))
}
function fit() {
  const bounds = new maplibregl.LngLatBounds()
  store.scheme.stages.flatMap((stage) => stage.route).forEach((point) => bounds.extend(point))
  store.scheme.detours.flatMap((route) => route.coordinates).forEach((point) => bounds.extend(point))
  map?.fitBounds(bounds, { padding: 60 })
}
onMounted(async () => {
  await nextTick()
  map = new maplibregl.Map({
    container: mapEl.value!,
    style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] },
    center: [121.488, 31.23], zoom: 13,
  })
  map.addControl(new maplibregl.NavigationControl(), 'top-right')
  map.on('load', drawAll)
  map.on('click', (event) => store.addPoint([event.lngLat.lng, event.lngLat.lat]))
})
onBeforeUnmount(() => map?.remove())
watch(() => store.selectedStageId, () => {
  const stage = store.selectedStage
  if (map && stage) { map.flyTo({ center: stage.route[0], zoom: 14 }); drawAll() }
})
watch(() => store.links, () => drawAll(), { deep: false })
watch(layers, applyVisibility, { deep: true })
</script>

<template>
  <section class="page-head compact"><div><p class="eyebrow">几何与时间联动 · 改动即重算容量账</p><h1>封路范围与阶段地图</h1><p>金色描边是绕行与急救/公交共用路面；改阶段时间、车道或路线会让旧预占和关联会签失效。</p></div><a-space><a-button @click="store.startDraw" :status="store.drawing ? 'danger' : undefined">{{ store.drawing ? `绘制中 · 已点 ${store.draftRoute.length} 个` : '绘制封路路线' }}</a-button><a-button :disabled="!store.drawing" type="primary" @click="store.finishDraw">完成绘制并重算</a-button><a-button @click="fit">定位全段</a-button></a-space></section>
  <div class="toolbar card"><a-radio-group v-model="store.selectedStageId" type="button"><a-radio v-for="stage in store.scheme.stages" :key="stage.id" :value="stage.id">{{ stage.id }}</a-radio></a-radio-group><span class="spacer"></span><a-checkbox v-model="layers.closure">封路</a-checkbox><a-checkbox v-model="layers.detour">绕行</a-checkbox><a-checkbox v-model="layers.ambulance">急救通道</a-checkbox><a-checkbox v-model="layers.bus">公交</a-checkbox><a-checkbox v-model="layers.adjacent">相邻工程</a-checkbox><a-checkbox v-model="layers.shared">共用路面</a-checkbox></div>
  <div class="map-grid">
    <div ref="mapEl" class="map"></div>
    <aside class="card inspector">
      <div class="panel-head"><div><h2>{{ store.selectedStage?.name }}</h2><p>{{ store.selectedStage?.start }} → {{ store.selectedStage?.end }}</p></div><a-tag :color="store.selectedStage?.status === '退回' ? 'red' : 'orange'">{{ store.selectedStage?.status }}</a-tag></div>
      <a-alert type="warning" class="mb12" title="修改开始/结束/车道/路线会使容量账升版，旧预占与锚定会签失效，须重算恢复" />
      <a-form layout="vertical" :model="store.selectedStage || {}">
        <a-form-item label="车道占用"><a-input :model-value="store.selectedStage?.lanes" @change="(value: string) => store.updateStage({ lanes: value })" /></a-form-item>
        <a-form-item label="阶段名称"><a-input :model-value="store.selectedStage?.name" @change="(value: string) => store.updateStage({ name: value })" /></a-form-item>
        <div class="two"><a-form-item label="开始"><a-date-picker :model-value="store.selectedStage?.start" style="width:100%" @change="(value: any) => store.updateStage({ start: value })" /></a-form-item><a-form-item label="结束"><a-date-picker :model-value="store.selectedStage?.end" style="width:100%" @change="(value: any) => store.updateStage({ end: value })" /></a-form-item></div>
      </a-form>
      <a-divider />
      <h3>共用路面（绕行 / 急救 / 公交）</h3>
      <div v-if="!sharedLinks.length" class="muted">当前方案无共线路链</div>
      <div v-for="link in sharedLinks" :key="link.id" class="shared">
        <b>{{ link.id }}</b><small v-for="u in link.users" :key="u.type + u.id" class="who" :class="u.type">{{ u.label }}</small>
        <small>名义能力 {{ link.nominal }} pcu/30min</small>
      </div>
      <a-divider />
      <h3>绕行比较</h3>
      <div v-for="route in store.scheme.detours" :key="route.id" class="detour"><div><b>{{ route.name }}</b><small>{{ route.distance }} km · 增加 {{ route.extraMinutes }} 分钟</small></div><a-tag :color="route.extraMinutes > 10 ? 'orange' : 'green'">{{ route.extraMinutes > 10 ? '关注' : '可用' }}</a-tag></div>
      <a-divider />
      <h3>容量账冲突</h3>
      <div v-for="item in store.conflicts.filter((conflict) => conflict.segmentId === store.selectedStageId)" :key="item.id" class="issue" :class="item.level === '高' ? 'red' : 'amber'"><b>{{ item.title }}</b><p>{{ item.detail }}</p></div>
      <a-button long type="outline" class="mt12" @click="$router.push('/capacity')">打开半小时容量账</a-button>
    </aside>
  </div>
</template>

<style scoped>
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px;margin-bottom:14px}.spacer{flex:1}.map-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(340px,.65fr);gap:16px}.map{height:min(68vh,680px);min-height:420px;border-radius:8px;overflow:hidden}.inspector{height:fit-content;max-height:min(68vh,680px);overflow:auto}.panel-head{display:flex;justify-content:space-between}.panel-head h2{font-size:18px;margin:0 0 5px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.inspector h3{font-size:14px;margin:18px 0 10px}.muted{color:#98a2b3;font-size:13px}.shared{border:1px solid #fde68a;background:#fffbeb;border-radius:6px;padding:9px 10px;margin-bottom:8px}.shared b{display:block;margin-bottom:5px}.shared .who{display:inline-block;margin:0 6px 5px 0;padding:1px 7px;border-radius:9px;font-size:11px;background:#eef2f7}.shared .who.ambulance,.shared .who.amb{color:#16a34a}.who.ambulance{color:#16a34a}.who.bus{color:#d97706}.who.detour{color:#2563eb}.shared small{display:block;color:#7a8798;font-size:11px}.detour{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f5}.detour b,.detour small{display:block}.detour small{color:#7a8798;margin-top:4px}.issue{padding:10px;border-radius:6px;margin-bottom:8px}.issue.red{background:#fff1f2}.issue.amber{background:#fff7ed}.issue p{margin:4px 0 0;color:#64748b;font-size:13px}.mb12{margin-bottom:12px}.mt12{margin-top:12px}
@media(max-width:1050px){.map-grid{grid-template-columns:1fr}.map{height:55vh}}
</style>
