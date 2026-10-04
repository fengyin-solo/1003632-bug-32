import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { ensureDutyData } from './api/duty-service'
import './styles/global.css'

// 挂载前先做值勤数据兼容迁移：重算待交接标记、补录历史交接记录、重建检查站提醒。
ensureDutyData()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
