import { useQuery } from '@tanstack/react-query';
import { fetchYouTubeLiveBroadcasts } from '@/services/youtubeService';
import { useAuthStore } from '@/stores/authStore';

export function useYoutubeBroadcasts() {
  const isAuthed = useAuthStore(s => s.isYoutubeAuthed);
  return useQuery({
    queryKey: ['youtube', 'broadcasts'],
    queryFn: fetchYouTubeLiveBroadcasts,
    enabled: isAuthed,
    staleTime: 15 * 1000,
    retry: 2,
    refetchInterval: isAuthed ? 60 * 1000 : false,
  });
}
