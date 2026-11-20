import pandas as pd, json, sys
d=pd.read_csv(sys.argv[1],encoding='utf-8-sig')
d['hol']=d.esferiado.astype(str).str.lower()=='true'
g=d.groupby(['fecha','tienda','nombre_dept','tipo','hol','tamaño'],as_index=False).ventas_semanales.sum()
dates=sorted(g.fecha.unique()); depts=sorted(g.nombre_dept.unique())
out={"source":"walmart_sales_2012.csv","dates":dates,"depts":depts,
 "stores":{str(s):[t,int(z)] for s,t,z in g[['tienda','tipo','tamaño']].drop_duplicates().itertuples(index=False)},
 "cols":["date_idx","store","dept_idx","holiday","sales"],
 "rows":[[dates.index(f),int(s),depts.index(n),int(h),round(float(v),2)] for f,s,n,t,h,z,v in g.itertuples(index=False)]}
json.dump(out,open(sys.argv[2],'w',encoding='utf-8'),ensure_ascii=False,separators=(',',':'))
print(len(g), round(g.ventas_semanales.sum()/1e6,2), g.tienda.nunique(), g.nombre_dept.nunique())
