import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '슬랑 비누',
    short_name: '슬랑 비누',
    description: '꾹 누르면 바삭, 놓으면 말랑. 손끝으로 만지는 비누 말랑이.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f2f4f6',
    theme_color: '#f2f4f6',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
