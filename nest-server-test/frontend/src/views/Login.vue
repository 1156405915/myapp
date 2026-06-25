<template>
  <div class="login-container">
    <div class="glass-panel login-box">
      <div class="logo">
        <el-icon :size="40" color="#8E54E9"><UserFilled /></el-icon>
      </div>
      <h2 class="title">Welcome Back</h2>
      <p class="subtitle">Log in to your account</p>

      <el-form :model="loginForm" :rules="rules" ref="loginFormRef" @keyup.enter="handleLogin">
        <el-form-item prop="account">
          <el-input 
            v-model="loginForm.account" 
            placeholder="Username or Phone" 
            :prefix-icon="User"
            size="large"
          />
        </el-form-item>
        
        <el-form-item prop="password">
          <el-input 
            v-model="loginForm.password" 
            type="password" 
            placeholder="Password" 
            :prefix-icon="Lock"
            show-password
            size="large"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" class="submit-btn" :loading="loading" @click="handleLogin" size="large">
            Sign In
          </el-button>
        </el-form-item>
      </el-form>

      <div class="footer-links">
        <span>Don't have an account? </span>
        <router-link to="/register" class="link">Create one now</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { User, Lock, UserFilled } from '@element-plus/icons-vue';
import type { FormInstance, FormRules } from 'element-plus';
import request from '../utils/request';

const router = useRouter();
const loginFormRef = ref<FormInstance>();
const loading = ref(false);

const loginForm = reactive({
  account: '',
  password: '',
});

const rules = reactive<FormRules>({
  account: [{ required: true, message: 'Please input username or phone', trigger: 'blur' }],
  password: [
    { required: true, message: 'Please input password', trigger: 'blur' },
    { min: 6, message: 'Password must be at least 6 characters', trigger: 'blur' }
  ],
});

const handleLogin = async () => {
  if (!loginFormRef.value) return;
  
  await loginFormRef.value.validate(async (valid) => {
    if (valid) {
      loading.value = true;
      try {
        const isPhone = /^\d+$/.test(loginForm.account);
        const payload = isPhone 
          ? { phone: loginForm.account, password: loginForm.password }
          : { username: loginForm.account, password: loginForm.password };

        await request.post('/auth/login', payload);
        router.push('/users');
      } catch (error) {
        console.error(error);
      } finally {
        loading.value = false;
      }
    }
  });
};
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 80vh;
}

.login-box {
  width: 100%;
  max-width: 400px;
}

.logo {
  text-align: center;
  margin-bottom: 10px;
}

.title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.subtitle {
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
  margin-bottom: 30px;
}

.submit-btn {
  width: 100%;
  margin-top: 10px;
  font-weight: 600;
  border-radius: 8px;
}

.footer-links {
  margin-top: 20px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
}

.link {
  color: #8E54E9;
  text-decoration: none;
  font-weight: 500;
  transition: color 0.2s;
}

.link:hover {
  color: #4776E6;
}
</style>
