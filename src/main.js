import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './styles/dark.css'

// 挂载前先恢复主题，避免深色用户每次启动都闪一帧亮色。
const savedTheme = localStorage.getItem('zhixu-theme')
if (savedTheme === 'dark' || savedTheme === 'light') {
  document.documentElement.dataset.theme = savedTheme
}

createApp(App).mount('#app')
