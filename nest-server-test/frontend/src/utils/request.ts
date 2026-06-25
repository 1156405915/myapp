import axios from 'axios';
import { ElMessage } from 'element-plus';

const service = axios.create({
  baseURL: 'http://localhost:3000', // 默认后端地址
  timeout: 5000,
});

service.interceptors.request.use(
  (config) => {
    // 如果有 token 可以加在这里
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

service.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    const msg = error.response?.data?.message || error.message || '网络请求失败';
    ElMessage.error(msg);
    return Promise.reject(error);
  }
);

export default service;
