import { createRouter, createWebHistory } from 'vue-router'
import OverviewView from './views/OverviewView.vue'
import MapView from './views/MapView.vue'
import ReviewView from './views/ReviewView.vue'
import CapacityView from './views/CapacityView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView },
    { path: '/map', name: 'map', component: MapView },
    { path: '/capacity', name: 'capacity', component: CapacityView },
    { path: '/review', name: 'review', component: ReviewView },
  ],
})
