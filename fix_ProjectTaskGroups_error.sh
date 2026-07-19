sed -i 's/if(!res.ok) let err="Error";/if(!res.ok) { let err="Error";/g' components/project/ProjectTaskGroups.tsx
sed -i 's/throw new Error(err);/throw new Error(err); }/g' components/project/ProjectTaskGroups.tsx
