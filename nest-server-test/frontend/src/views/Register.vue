<template>
  <div class="register-container">
    <div class="glass-panel register-box">
      <div class="logo">
        <el-icon :size="40" color="#8E54E9"><UserFilled /></el-icon>
      </div>
      <h2 class="title">Create Account</h2>
      <p class="subtitle">Join us today</p>

      <el-form :model="registerForm" :rules="rules" ref="registerFormRef" @keyup.enter="handleRegister">
        <el-form-item prop="username">
          <el-input 
            v-model="registerForm.username" 
            placeholder="Username" 
            :prefix-icon="User"
            size="large"
          />
        </el-form-item>

        <el-form-item prop="phone">
          <el-input 
            v-model="registerForm.phone" 
            placeholder="Phone Number (11 digits)" 
            :prefix-icon="Phone"
            size="large"
          />
        </el-form-item>
        
        <el-form-item prop="password">
          <el-input 
            v-model="registerForm.password" 
            type="password" 
            placeholder="Password (min 6 chars)" 
            :prefix-icon="Lock"
            show-password
            size="large"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" class="submit-btn" :loading="loading" @click="handleRegister" size="large">
            Sign Up
          </el-button>
        </el-form-item>
      </el-form>

      <div class="footer-links">
        <span>Already have an account? </span>
        <router-link to="/login" class="link">Sign in instead</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { User, Lock, Phone, UserFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import request from '../utils/request';

const router = useRouter();
const registerFormRef = ref<FormInstance>();
const loading = ref(false);

const registerForm = reactive({
  username: '',
  phone: '',
  password: '',
});

const rules = reactive<FormRules>({
  username: [{ required: true, message: 'Please input username', trigger: 'blur' }],
  phone: [
    { required: true, message: 'Please input phone number', trigger: 'blur' },
    { len: 11, message: 'Phone number must be exactly 11 digits', trigger: 'blur' }
  ],
  password: [
    { required: true, message: 'Please input password', trigger: 'blur' },
    { min: 6, max: 20, message: 'Password must be between 6 and 20 characters', trigger: 'blur' }
  ],
});

const handleRegister = async () => {
  if (!registerFormRef.value) return;
  
  await registerFormRef.value.validate(async (valid) => {
    if (valid) {
      loading.value = true;
      try {
        await request.post('/auth/register', registerForm);
        ElMessage.success('Registration successful! Please login.');
        router.push('/login');
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
.register-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 80vh;
}

.register-box {
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
