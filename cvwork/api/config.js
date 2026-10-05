export default async function(req,res){
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    tmdbConfigured: Boolean(process.env.TMDB_API_KEY)
  });
}
