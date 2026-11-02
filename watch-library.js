'use strict';
// Parent-curated official creator/publisher links. Durations and playback availability are not inferred.
globalThis.STUDIO_WATCH_LIBRARY=Object.freeze([
  {provider:'youtube',videoId:'ENnEYoUpFfU',ti:'Fundamentals of Lighting in Blender',ch:'Blender Guru',why:'Light size, falloff, staging and color'},
  {provider:'youtube',videoId:'fxz6p-QATfs',ti:'The animation of Flow',ch:'Blender · BCON2024',why:'Feature animation production workflow'},
  {provider:'youtube',videoId:'8yHuJLeAAsA',ti:'Inklines Across the Spider-Verse',ch:'Blender / Sony Imageworks',why:'Linework and 3D shot breakdowns'},
  {provider:'youtube',videoId:'Tm2nn8OXFVk',ti:'A feature animation pipeline with a woolly look',ch:'Blender · BCON26',why:'Geometry Nodes grooming and lighting'},
  {provider:'youtube',videoId:'C-AjCqjKRSs',ti:'Profiling with Purpose',ch:'Unreal Engine',why:'Performance lessons from a real project'},
  {provider:'youtube',videoId:'1uFR9lXrpyQ',ti:'UE5 Optimization: Lighting & Shadows',ch:'Tom Looman',why:'Virtual shadow maps and light costs'},
  {provider:'youtube',videoId:'wL5Hf1hT6c4',ti:'Lessons from Optimizing Chaos',ch:'Unreal Engine',why:'Physics, threading and measured profiling'},
  {provider:'youtube',videoId:'SqPaL8HS_Lw',ti:'Everything You Wanted to Know About Substrate',ch:'Unreal Engine',why:'Material layering and migration'},
  {provider:'vimeo',videoId:'340544320',ti:'Advanced Vellum Workflows',ch:'SideFX / John Lynch',why:'Constraints and solver workflows · older H17 UI'},
  {provider:'vimeo',videoId:'999739285',ti:'MPM H20.5 Masterclass',ch:'SideFX',why:'Simulation workflow and example files'},
  {provider:'youtube',videoId:'w2Knw9bD06Y',ti:'Solaris/USD Workflows with Unreal',ch:'SideFX / Peter Arcara',why:'Non-destructive USD variants · 2022 UI'},
  {provider:'vimeo',videoId:'1125207167',ti:'MaterialX Introduction',ch:'SideFX / Peter Arcara',why:'Karma MaterialX concepts'},
  {provider:'youtube',videoId:'WigIALCnEvw',ti:'Timing animations',ch:'Remotion official resources',why:'Timing functions and playground examples'},
  {provider:'youtube',videoId:'uDqjIdI4bF4',ti:'12 Principles of Animation',ch:'Alan Becker Tutorials',why:'Timing, staging and arcs'},
  {provider:'youtube',videoId:'7A70hBrPL4I',ti:'Record and analyze a performance trace',ch:'Chrome Developers',why:'LCP, CLS and trace inspection'},
  {provider:'youtube',videoId:'KxjGYcHZ_uI',ti:'Override and mock network responses',ch:'Chrome Developers',why:'Local API and UI verification'}
].map(v=>Object.freeze({...v,id:'curated-'+v.provider+'-'+v.videoId,curated:true})));
